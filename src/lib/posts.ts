import { getCollection, type CollectionEntry } from 'astro:content';
import type { Lang } from '../i18n';

export type Post = CollectionEntry<'blog'>;

const LANG_RE = /\.(es|en)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}-/;

export function postLang(post: Post): Lang {
  const m = post.id.match(LANG_RE);
  return (m?.[1] as Lang) ?? 'es';
}

export function postSlug(post: Post): string {
  return post.id.replace(DATE_RE, '').replace(LANG_RE, '');
}

export async function getPosts(lang: Lang): Promise<Post[]> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts
    .filter((p) => postLang(p) === lang)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export async function getPostBySlug(slug: string, lang: Lang): Promise<Post | undefined> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.find((p) => postSlug(p) === slug && postLang(p) === lang);
}
