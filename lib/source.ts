import { docs } from 'collections/server'
import { loader } from 'fumadocs-core/source'
import type { DocsCollectionEntry } from 'fumadocs-mdx/runtime/server'

const isDocsCollection = (value: unknown): value is DocsCollectionEntry<'docs'> => {
  if (typeof value !== 'object' || value === null) return false
  if (!('docs' in value) || !Array.isArray(value.docs)) return false
  if (!('meta' in value) || !Array.isArray(value.meta)) return false
  return 'toFumadocsSource' in value && typeof value.toFumadocsSource === 'function'
}

const docsCollection: DocsCollectionEntry<'docs'> = (() => {
  const candidate: unknown = docs
  if (!isDocsCollection(candidate)) {
    throw new Error('Invalid docs collection from collections/server')
  }
  return candidate
})()

export const source = loader({
  baseUrl: '/docs',
  source: docsCollection.toFumadocsSource(),
})
