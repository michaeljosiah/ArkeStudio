import { useState } from "react";
import type { WorldChatWorkspace } from "@arke-studio/contracts";
import { mediaUrl } from "../lib/media.js";

type Attachment = WorldChatWorkspace["attachments"][number];

function SentAttachment({ attachment, worldSlug }: { attachment?: Attachment; worldSlug?: string }) {
  const [failed, setFailed] = useState(false);
  if (!attachment) return <span className="fy-chat-attachment">Attachment unavailable</span>;
  const image = attachment.kind === "image";
  return <span className="fy-chat-attachment">
    {image && (attachment.imagePath && worldSlug && !failed
      ? <img src={mediaUrl(worldSlug, attachment.imagePath)} alt={attachment.fileName} loading="lazy" onError={() => setFailed(true)} />
      : <span className="fy-chat-attachment__notice">Preview unavailable</span>)}
    <span>{attachment.fileName}{!image && (attachment.readability === "not-readable" ? " · not readable in chat" : attachment.readability === "extracted-text-available" ? " · text only" : "")}</span>
  </span>;
}

/** Message membership comes from the journal, never from today's composer selection. */
export function ConversationAttachments({ ids, attachments, worldSlug }: { ids: readonly string[]; attachments: readonly Attachment[]; worldSlug?: string }) {
  if (!ids.length) return null;
  return <div className="fy-chat-attachments" aria-label="Sent attachments">
    {ids.map(id => {
      const attachment = attachments.find(row => row.id === id);
      return <SentAttachment key={`${worldSlug}:${id}:${attachment?.imagePath}`} attachment={attachment} worldSlug={worldSlug} />;
    })}
  </div>;
}
