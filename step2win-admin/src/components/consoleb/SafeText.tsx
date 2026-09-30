import { Fragment, type ReactNode } from 'react'

/**
 * Renders the announcement / help-article text subset without any HTML injection:
 * paragraphs, "- " bullet lists, **bold** and [label](https://... or /path) links.
 * Mirrors step2win-web/src/components/content/SafeText.tsx.
 */
const INLINE = /(\*\*[^*]+\*\*|\[[^\]]+\]\((?:https:\/\/[^\s)]+|\/[^\s)]*)\))/g

function inline(text: string, key: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    const k = `${key}-${i}`
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={k} className="font-semibold">{part.slice(2, -2)}</strong>
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      const external = link[2].startsWith('https://')
      return (
        <a key={k} href={link[2]} className="font-medium text-brand-text underline underline-offset-2"
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
          {link[1]}
        </a>
      )
    }
    return <Fragment key={k}>{part}</Fragment>
  })
}

export function SafeText({ text, className }: { text: string; className?: string }) {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
  return (
    <div className={className}>
      {blocks.map((block, bi) => {
        const lines = block.split('\n')
        if (lines.every((l) => /^\s*-\s+/.test(l))) {
          return (
            <ul key={bi} className="my-1 list-disc space-y-0.5 pl-5">
              {lines.map((l, li) => <li key={li}>{inline(l.replace(/^\s*-\s+/, ''), `${bi}-${li}`)}</li>)}
            </ul>
          )
        }
        return (
          <p key={bi} className="my-1 first:mt-0 last:mb-0">
            {lines.map((l, li) => (
              <Fragment key={li}>{li > 0 && <br />}{inline(l, `${bi}-${li}`)}</Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
