import { useEffect, useRef, useState, type ReactNode } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import {
  AlignCenter, AlignLeft, Bold, Heading1, Heading2, Heading3, Italic, Link2, List, ListOrdered, Minus, Pilcrow, Quote, Redo2,
  Underline as UnderlineIcon, Undo2, Unlink,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { DOC_TYPOGRAPHY } from './api'

interface LegalEditorProps {
  initialHtml: string
  /** First value is the editor-normalised version of `initialHtml` (used as the clean baseline). */
  onReady: (html: string) => void
  onChange: (html: string) => void
  label: string
}

/** Rich-text editor for legal documents, limited to what the sanitizer and the app render. */
export function LegalEditor({ initialHtml, onReady, onChange, label }: LegalEditorProps) {
  const ready = useRef(onReady)
  const change = useRef(onChange)
  useEffect(() => { ready.current = onReady; change.current = onChange })

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        strike: false,
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
      }),
      TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center'] }),
    ],
    content: initialHtml,
    editorProps: {
      attributes: {
        'aria-label': label,
        'aria-multiline': 'true',
        role: 'textbox',
        class: cn('min-h-[420px] px-6 py-5 outline-none sm:px-10', DOC_TYPOGRAPHY),
      },
    },
    onCreate: ({ editor: e }) => ready.current(e.getHTML()),
    onUpdate: ({ editor: e }) => change.current(e.getHTML()),
  })

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-surface-border bg-surface-card focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15">
      {editor && <Toolbar editor={editor} />}
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface-card">
        <div className="mx-auto max-w-[72ch]">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      p: e.isActive('paragraph'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      center: e.isActive({ textAlign: 'center' }),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  })
  const [linkOpen, setLinkOpen] = useState(false)
  const c = () => editor.chain().focus()

  return (
    <>
      <div role="toolbar" aria-label="Formatting" className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-surface-border bg-surface-base px-2 py-1.5">
        <Group>
          <Tool label="Paragraph" pressed={s.p} onClick={() => c().setParagraph().run()}><Pilcrow size={15} /></Tool>
          <Tool label="Heading 1" pressed={s.h1} onClick={() => c().toggleHeading({ level: 1 }).run()}><Heading1 size={15} /></Tool>
          <Tool label="Heading 2" pressed={s.h2} onClick={() => c().toggleHeading({ level: 2 }).run()}><Heading2 size={15} /></Tool>
          <Tool label="Heading 3" pressed={s.h3} onClick={() => c().toggleHeading({ level: 3 }).run()}><Heading3 size={15} /></Tool>
        </Group>
        <Group>
          <Tool label="Bold (Ctrl+B)" pressed={s.bold} onClick={() => c().toggleBold().run()}><Bold size={15} /></Tool>
          <Tool label="Italic (Ctrl+I)" pressed={s.italic} onClick={() => c().toggleItalic().run()}><Italic size={15} /></Tool>
          <Tool label="Underline (Ctrl+U)" pressed={s.underline} onClick={() => c().toggleUnderline().run()}><UnderlineIcon size={15} /></Tool>
        </Group>
        <Group>
          <Tool label="Bulleted list" pressed={s.bullet} onClick={() => c().toggleBulletList().run()}><List size={15} /></Tool>
          <Tool label="Numbered list" pressed={s.ordered} onClick={() => c().toggleOrderedList().run()}><ListOrdered size={15} /></Tool>
          <Tool label="Quote" pressed={s.quote} onClick={() => c().toggleBlockquote().run()}><Quote size={15} /></Tool>
          <Tool label="Divider" onClick={() => c().setHorizontalRule().run()}><Minus size={15} /></Tool>
        </Group>
        <Group>
          <Tool label="Align left" pressed={!s.center} onClick={() => c().setTextAlign('left').run()}><AlignLeft size={15} /></Tool>
          <Tool label="Align centre" pressed={s.center} onClick={() => c().setTextAlign('center').run()}><AlignCenter size={15} /></Tool>
        </Group>
        <Group>
          <Tool label={s.link ? 'Edit link' : 'Add link'} pressed={s.link} onClick={() => setLinkOpen(true)}><Link2 size={15} /></Tool>
          {s.link && <Tool label="Remove link" onClick={() => c().extendMarkRange('link').unsetLink().run()}><Unlink size={15} /></Tool>}
        </Group>
        <div className="ml-auto flex items-center gap-0.5">
          <Tool label="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={() => c().undo().run()}><Undo2 size={15} /></Tool>
          <Tool label="Redo (Ctrl+Shift+Z)" disabled={!s.canRedo} onClick={() => c().redo().run()}><Redo2 size={15} /></Tool>
        </div>
      </div>
      <LinkDialog open={linkOpen} editor={editor} onClose={() => setLinkOpen(false)} />
    </>
  )
}

function Group({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-0.5 border-r border-surface-border pr-1 mr-1 last:border-r-0">{children}</div>
}

function Tool({ label, pressed, disabled, onClick, children }: { label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:opacity-40',
        pressed ? 'bg-brand-soft text-brand-text' : 'text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary',
      )}
    >
      {children}
    </button>
  )
}

function LinkDialog({ open, editor, onClose }: { open: boolean; editor: Editor; onClose: () => void }) {
  if (!open) return null
  return <LinkDialogBody editor={editor} onClose={onClose} />
}

function LinkDialogBody({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [url, setUrl] = useState<string>(() => (editor.getAttributes('link').href as string | undefined) ?? '')
  const [error, setError] = useState<string | null>(null)
  const apply = () => {
    const v = url.trim()
    if (!/^(https?:\/\/|mailto:)/i.test(v)) { setError('Use a full link starting with https://, http:// or mailto:'); return }
    const chain = editor.chain().focus().extendMarkRange('link')
    if (editor.state.selection.empty && !editor.isActive('link')) {
      chain.insertContent({ type: 'text', text: v, marks: [{ type: 'link', attrs: { href: v } }] }).run()
    } else {
      chain.setLink({ href: v }).run()
    }
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Link"
      description="Links open in the device browser. Only web and email links are allowed."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={apply}>Apply link</Button></>}
    >
      <Input
        label="URL"
        value={url}
        autoComplete="off"
        placeholder="https://step2win.app/contact"
        onChange={(e) => { setUrl(e.target.value); setError(null) }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply() } }}
        error={error ?? undefined}
      />
    </Modal>
  )
}
