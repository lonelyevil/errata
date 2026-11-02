import { useState, useRef, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Send, Loader2, Square } from 'lucide-react'
import { EmptyHint } from '@/components/ui/prose-text'
import { AssistantMessageView } from '@/components/chat/ChatMessageParts'
import { useLibrarianChat } from '@/hooks/use-librarian-chat'
import { componentId } from '@/lib/dom-ids'

interface LibrarianChatProps {
  storyId: string
  branchId: string
  conversationId?: string | null
  initialInput?: string
}

export function LibrarianChat(props: LibrarianChatProps) {
  return <LibrarianChatSession key={JSON.stringify([props.storyId, props.branchId, props.conversationId ?? null])} {...props} />
}

function LibrarianChatSession({ storyId, branchId, conversationId, initialInput }: LibrarianChatProps) {
  const { messages, snapshot, loading, pending, busy, stopping, reconnecting, error, unsentPrompt, send, stop } = useLibrarianChat(storyId, branchId, conversationId)
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const initialInputAppliedRef = useRef<string | null>(null)
  const isNearBottomRef = useRef(true)

  useEffect(() => {
    if (initialInput && initialInput !== initialInputAppliedRef.current) {
      setInput(initialInput)
      initialInputAppliedRef.current = initialInput
      textareaRef.current?.focus()
    }
  }, [initialInput])

  useEffect(() => {
    if (unsentPrompt) setInput(unsentPrompt)
  }, [unsentPrompt])

  useEffect(() => {
    const scrollArea = messagesEndRef.current?.closest('[data-radix-scroll-area-viewport]')
    if (!scrollArea) return
    const handleScroll = () => {
      isNearBottomRef.current = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < 80
    }
    scrollArea.addEventListener('scroll', handleScroll, { passive: true })
    return () => scrollArea.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (isNearBottomRef.current) {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      messagesEndRef.current?.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth' })
    }
  }, [messages])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 400) + 'px'
  }, [input])

  const handleSend = useCallback(() => {
    if (send(input)) setInput('')
  }, [input, send])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const status = reconnecting ? 'Reconnecting…'
    : snapshot?.activeRun?.status === 'cancelling' || stopping ? 'Stopping response…'
      : pending ? 'Sending…' : loading ? 'Loading conversation…' : null

  return (
    <div className="flex flex-col h-full motion-reduce:[&_.animate-spin]:animate-none motion-reduce:[&_.animate-pulse]:animate-none" data-component-id="librarian-chat-root">
      <ScrollArea className="flex-1 min-h-0" data-component-id="librarian-chat-scroll">
        <div className="p-3 space-y-3">
          {messages.length === 0 && !loading && !pending && (
            <div className="flex flex-col items-center justify-center py-12 text-center" data-component-id="librarian-chat-empty">
              <EmptyHint className="max-w-[240px]">
                Ask the librarian to make changes across your story — update characters, adjust guidelines, or reshape knowledge.
              </EmptyHint>
            </div>
          )}

          {messages.map(msg => (
            <div
              key={msg.id}
              data-component-id={componentId('librarian-message', msg.id)}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${msg.role === 'user'
                ? 'bg-primary/10 text-foreground'
                : 'bg-card/50 border border-border/30 text-foreground/80'}`}>
                {msg.role === 'assistant' ? (
                  <>
                    <AssistantMessageView msg={{ ...msg, role: 'assistant' }} streaming={!!snapshot?.activeRun && msg.runId === snapshot.activeRun.runId} />
                    {msg.status && ['error', 'interrupted', 'cancelled'].includes(msg.status) && (
                      <p className="mt-1.5 text-[0.625rem] text-muted-foreground" data-component-id={componentId('librarian-message', msg.id, 'status')}>
                        {msg.error || (msg.status === 'cancelled' ? 'Response stopped.' : msg.status === 'interrupted' ? 'Response interrupted.' : 'Response failed.')}
                      </p>
                    )}
                  </>
                ) : <div className="break-words whitespace-pre-wrap">{msg.content}</div>}
              </div>
            </div>
          ))}

          {error && (
            <div role="alert" className="text-xs text-destructive bg-destructive/5 rounded-md p-2" data-component-id="librarian-chat-error">
              {error}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      <div className="border-t border-border/30 p-3 space-y-2">
        <div role="status" aria-live="polite" className={`text-[0.625rem] text-muted-foreground ${status ? '' : 'sr-only'}`} data-component-id="librarian-chat-status">
          {status}
        </div>
        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask the librarian..."
            aria-label="Ask the librarian"
            disabled={busy || loading || !snapshot}
            className="min-h-[40px] max-h-[400px] resize-none text-xs bg-transparent placeholder:italic placeholder:text-muted-foreground flex-1"
            rows={1}
            data-component-id="librarian-chat-input"
          />
          {snapshot?.activeRun ? (
            <Button
              size="icon"
              variant="outline"
              className="size-8 shrink-0"
              disabled={stopping || snapshot.activeRun.status === 'cancelling'}
              onClick={() => { void stop() }}
              aria-label="Stop response"
              title="Stop response"
              data-component-id="librarian-chat-stop"
            >
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-8 shrink-0"
              disabled={!input.trim() || busy || loading || !snapshot}
              onClick={handleSend}
              aria-label="Send message"
              data-component-id="librarian-chat-send"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Send className="size-3.5" />}
            </Button>
          )}
        </div>
        <p className="text-[0.625rem] text-muted-foreground text-center">
          Enter to send, Shift+Enter for newline
        </p>
      </div>
    </div>
  )
}
