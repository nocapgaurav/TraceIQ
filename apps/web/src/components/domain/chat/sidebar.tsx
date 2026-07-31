'use client';

import { MessageSquarePlus, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { describeSubject } from '@/hooks/use-chat';
import { cn } from '@/lib/utils';
import { REPOSITORY_SUBJECT, useChatStore } from '@/store/chat-store';

/**
 * The conversation list.
 *
 * In-session only — conversation storage is a deferred milestone, so nothing here writes to disk. A
 * conversation restored after a rescan would carry answers grounded in facts that no longer hold, which is
 * worse than losing it.
 *
 * A permanent column above `lg`, a dismissible overlay below, driven by the same store either way so there
 * is no second list to keep in step.
 */
export function ConversationSidebar({ onNavigate }: { readonly onNavigate?: () => void }) {
  const conversations = useChatStore((state) => state.conversations);
  const activeId = useChatStore((state) => state.activeId);
  const startConversation = useChatStore((state) => state.startConversation);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const removeConversation = useChatStore((state) => state.removeConversation);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 gap-2"
          onClick={() => {
            startConversation(REPOSITORY_SUBJECT);
            onNavigate?.();
          }}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          New conversation
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {conversations.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">No conversations yet.</p>
        ) : (
          <ul aria-label="Conversations" className="p-1">
            {conversations.map((conversation) => {
              const active = conversation.id === activeId;

              return (
                <li key={conversation.id} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => {
                      selectConversation(conversation.id);
                      onNavigate?.();
                    }}
                    className={cn(
                      'min-w-0 flex-1 rounded-md px-2 py-1.5 text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent',
                    )}
                  >
                    <span className="block truncate text-xs font-medium">{conversation.title}</span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {describeSubject(conversation.subject)}
                    </span>
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${conversation.title}`}
                    className="h-7 w-7 shrink-0"
                    onClick={() => {
                      removeConversation(conversation.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

/** The sidebar as an overlay, for narrow screens. Same store, same list, one component tree. */
export function SidebarOverlay() {
  const open = useChatStore((state) => state.sidebarOpen);
  const setOpen = useChatStore((state) => state.setSidebarOpen);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <button
        type="button"
        aria-label="Close conversations"
        className="absolute inset-0 bg-black/50"
        onClick={() => {
          setOpen(false);
        }}
      />
      <div className="absolute inset-y-0 left-0 w-[min(20rem,85vw)] border-r border-border bg-background">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Conversations</p>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close conversations"
            onClick={() => {
              setOpen(false);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="h-[calc(100%-2.75rem)]">
          <ConversationSidebar
            onNavigate={() => {
              setOpen(false);
            }}
          />
        </div>
      </div>
    </div>
  );
}
