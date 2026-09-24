import { useQuery } from '@tanstack/react-query'
import { supportApi } from './api'

export const TEMPLATES_KEY = ['support', 'templates'] as const
export const TAGS_KEY = ['support', 'tags'] as const

export function useTemplates() {
  return useQuery({ queryKey: TEMPLATES_KEY, queryFn: supportApi.templates, staleTime: 60_000 })
}

export function useTags() {
  return useQuery({ queryKey: TAGS_KEY, queryFn: supportApi.tags, staleTime: 60_000 })
}
