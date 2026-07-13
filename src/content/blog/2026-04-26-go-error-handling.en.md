---
title: "Go Error Handling: A Lean Pattern with Private Errors and Raise Constructors"
description: "Why public sentinel errors leak control, and how a private error type + Raise/Is API fixes it."
pubDate: 2026-04-26
tags: ["go", "error-handling", "patterns", "api-design"]
draft: false
---

## A bug worth telling

A teammate is writing a test helper. They want a fixture loader to "always return EOF when the path is empty" and, in a moment of cleverness, write `io.EOF = errors.New("test eof")` in a shared `setup_test.go`. The package compiles. Tests pass. A week later a streaming decoder elsewhere in the program — one nobody on the team owns — starts behaving oddly: it reads forever on small files. The decoder branches on `err == io.EOF`. The sentinel it imported is no longer the sentinel `bufio.Reader` returns. The check silently became unreachable across the whole binary.

Generalize the failure: every `var ErrFoo = errors.New("foo")` exported from a package is mutable global state. Anyone in the program can reassign it. The fix isn't more discipline — it's structure. Make the error type and sentinel private, expose controlled `Raise*` constructors and `Is*` predicates, and most of the structural pain in Go error handling disappears.

## Four pain points

Public sentinels are mutable globals. The compiler does not protect them. A line like the one below, dropped into any file of any package in the import graph, is a perfectly legal program:

```go
package shenanigans

import "io"
import "errors"

func init() {
	io.EOF = errors.New("hijacked")
}
```

Every downstream `errors.Is(err, io.EOF)` check now silently compares against the hijacker. There is no test you can write in `io` that catches this — the corruption happens in someone else's package, at init time, after your tests ran.

Typed errors with public fields have the same shape, one level deeper. If a package exports a `*ParseError` with a public `Line int` field, then a caller doing `var pe *ParseError; if errors.As(err, &pe) { pe.Line = 999 }` is mutating a value that may still be referenced by middleware up the call stack, by a logger, or by a retry path. Public fields on error types are a public setter you didn't mean to write.

API inconsistency across packages is the third tax. One dependency exports sentinels (`sql.ErrNoRows`, `io.EOF`), another exports types (`*os.PathError`, `*json.SyntaxError`), a third returns plain `fmt.Errorf` strings whose only handle is substring matching. Callers learn a new error vocabulary per dependency, and the wrapping code in your service layer becomes a translation desk between three idioms.

Wrapping without `%w` is the fourth and most common. Consider the difference:

```go
// Breaks the chain — errors.Is(returned, io.EOF) is false.
return fmt.Errorf("load %s: %v", path, err)

// Preserves it — errors.Is(returned, io.EOF) is true.
return fmt.Errorf("load %s: %w", path, err)
```

The first form flattens the cause to a string. The chain is gone. `errors.Is` and `errors.As` return false on a value they would otherwise have matched. The bug is invisible until someone tries to branch on a wrapped sentinel and silently falls through to the default arm.

The four are different symptoms of the same disease: the standard library's error machinery rewards encapsulation, but `errors.New` plus `var Err...` actively encourages the opposite.

## The pattern

The hybrid is small. One private sentinel, one private type, one `Is` method that bridges them, and three exported functions: `Raise*`, `Is*`, and (when needed) `As*`. Here is the whole thing for a single error in a `user` package:

```go
package user

import (
	"errors"
	"fmt"
)

// Private sentinel — never exported. Exists so callers can match via the
// public predicate below without coupling to the type.
var errUserNotFound = errors.New("user not found")

// Private error type — callers cannot construct or mutate it.
type userNotFoundError struct {
	userID string
	cause  error
}

func (e *userNotFoundError) Error() string {
	return fmt.Sprintf("user %q not found", e.userID)
}

func (e *userNotFoundError) Unwrap() error { return e.cause }

// Is lets errors.Is(err, errUserNotFound) match. errUserNotFound is unexported,
// so the match is only reachable via IsUserNotFound below.
func (e *userNotFoundError) Is(target error) bool {
	return target == errUserNotFound
}

// RaiseUserNotFound is the single, controlled constructor.
func RaiseUserNotFound(userID string, cause error) error {
	return &userNotFoundError{userID: userID, cause: cause}
}

// IsUserNotFound is the public predicate. Callers never see the type.
func IsUserNotFound(err error) bool {
	return errors.Is(err, errUserNotFound)
}

// AsUserNotFound exposes structured data when callers need it.
// The struct is unexported, so callers can read fields via this helper but
// cannot construct one outside the package.
func AsUserNotFound(err error) (userID string, ok bool) {
	var e *userNotFoundError
	if errors.As(err, &e) {
		return e.userID, true
	}
	return "", false
}
```

Walk it from the top. `errUserNotFound` is a lowercase sentinel — it exists only inside `user`. No other package can name it, copy it, or reassign it. The `userNotFoundError` struct is also unexported, with unexported fields. Callers cannot allocate one, cannot embed one, cannot change `userID` after the fact. The only path that produces a value of this type is `RaiseUserNotFound`, which means every error of this kind in your program was created by code you control.

The `Is` method is the load-bearing trick. It tells `errors.Is` that an instance of `userNotFoundError` should be considered equal to the private sentinel. Callers cannot invoke this directly — they cannot name the sentinel — but `IsUserNotFound` can, and it is the single doorway through which the match reaches the outside world. `Unwrap` then carries the original cause (`sql.ErrNoRows`, a network error, anything) so that `errors.Is(err, sql.ErrNoRows)` keeps working further up the chain. `AsUserNotFound` is the escape hatch for callers who genuinely need the `userID`: it gives read-only field access through a controlled return, without ever exposing the struct itself.

The shape is the entire point. The public surface of the package — for this one error — is exactly three identifiers: `RaiseUserNotFound`, `IsUserNotFound`, `AsUserNotFound`. Everything else is internal and free to change.

## Why it works

The encapsulation argument is the obvious one. There is no mutable global to hijack and no field to mutate. But the deeper benefit is that the public surface is decoupled from the implementation. Today the package matches by sentinel; tomorrow you can switch to type matching, add a `kind` discriminator, split one error into three, or merge two into one — and as long as `IsUserNotFound` keeps returning the right boolean, no caller breaks. There is exactly one source of truth for "is this error a not-found?" and it lives where the error is defined.

Refactor-friendliness compounds. Renaming `errUserNotFound` is a single-package change. Adding a new field to `userNotFoundError` is a single-package change. Even removing the sentinel entirely and reimplementing `IsUserNotFound` as a type assertion is a single-package change. Compare this with a public `var ErrUserNotFound`: every caller has imported the symbol by name, every renaming is an API break, every change to how matching works is observable.

The pattern composes cleanly with the standard library. `errors.Is` and `errors.As` walk `Unwrap` chains, so wrapping with `%w` keeps every predicate working. Stack traces, structured logs, and middleware that already speak `errors.Is` need no special-casing.

This shape is not new. `os.IsNotExist` has done a version of it for years — a predicate over a private detail (originally a typed check on `*PathError`, later widened to walk the chain). Callers were never supposed to import a sentinel; they were supposed to ask the question through a function. The pattern is idiomatic in the standard library, just under-documented and under-imitated.

## A real example: a user repository

Sketch a `user` package with three errors built the same way: `RaiseUserNotFound`, `RaiseUserAlreadyExists`, `RaiseInvalidEmail`. Each has its private sentinel, its private type, its `Is` method, and its three exported helpers. The repository method then looks like ordinary Go, with the only twist being that translation from infrastructure errors to domain errors happens at the boundary where it belongs.

```go
func (r *Repo) Get(ctx context.Context, id string) (*User, error) {
	row := r.db.QueryRowContext(ctx, "SELECT id, email FROM users WHERE id = $1", id)
	var u User
	if err := row.Scan(&u.ID, &u.Email); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, RaiseUserNotFound(id, err)
		}
		return nil, fmt.Errorf("user.Get: %w", err)
	}
	return &u, nil
}
```

Two things to notice. First, `sql.ErrNoRows` never escapes the repository — the boundary translates it into a domain error whose meaning the caller actually cares about. Second, the wrapping uses `%w`, so the original `sql.ErrNoRows` is still reachable through the chain if a logger or a metric wants it. The domain semantics are explicit; the infrastructure detail is preserved but demoted.

Callers branch through the predicates without ever touching a type:

```go
u, err := repo.Get(ctx, id)
switch {
case user.IsUserNotFound(err):
	// 404
case user.IsInvalidEmail(err):
	// 422
case err != nil:
	// 500
}
_ = u
```

There is no `errors.As` in the caller, no type imported from `user`, no risk of mutating anything. The branching reads like a small business-rule table, which is what it is.

The HTTP edge becomes a clean mapping function — the kind of thing that is genuinely pleasant to write a unit test for, because the inputs are domain errors and the outputs are integers:

```go
func status(err error) int {
	switch {
	case user.IsUserNotFound(err):
		return http.StatusNotFound
	case user.IsUserAlreadyExists(err):
		return http.StatusConflict
	case user.IsInvalidEmail(err):
		return http.StatusUnprocessableEntity
	default:
		return http.StatusInternalServerError
	}
}
```

If a fourth domain error appears next quarter, the change is localized: define it in `user`, add an arm in `status`. No caller changes the way it constructs or inspects errors, because the construction and inspection live behind functions.

## Trade-offs

The honest cost is roughly fifteen lines of boilerplate per error: sentinel, type, `Error`, `Unwrap`, `Is`, `Raise*`, `Is*`, and optionally `As*`. For a domain with two or three errors that is a fair price. For a domain with thirty, it gets tedious enough that a generator earns its keep. A small `go generate` template that takes a name and emits the eight lines is twenty minutes of work and pays back forever:

```go
//go:generate go run ./internal/errgen -package user -name UserNotFound -name UserAlreadyExists -name InvalidEmail
```

Skip the pattern entirely for one-off internal errors. An `errors.New("retry exhausted")` deep inside an unexported function that no caller will ever branch on is fine. The pattern earns its weight when a caller might want to react to the error specifically — when there is a real predicate hiding in the code. If the only consumer is a log line, plain `fmt.Errorf` is correct.

The real downside is that callers who want to inspect arbitrary internal fields are stuck with whatever `As*` exposes. That is a feature most days and a friction the day a debugger needs more. Design the accessor surface deliberately: expose what the domain needs, not the whole struct, and add to it when a real consumer asks. Resist the urge to widen `As*` returns "just in case" — every field you expose becomes a field you cannot quietly rename.

## In short

Errors private by default. Expose `Raise*` constructors and `Is*` predicates. Let the standard library do the matching through `Unwrap`. The boilerplate is the point — it is the price of a stable public surface that survives refactors.
