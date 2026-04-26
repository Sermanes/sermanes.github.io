# sermanes.github.io

Web personal — SRE consultant.

## Stack
Astro + Tailwind. Deploy auto a GitHub Pages via Actions.

## Dev
```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # genera ./dist
npm run preview
```

## Deploy
Push a `master` → workflow `.github/workflows/deploy.yml` build + publica.

Settings → Pages → Source: **GitHub Actions**.
