import { useEffect } from "react";
import { useNavigate } from "react-router";
import { toast, Toaster } from "sonner";
import type { Job } from "@arke-studio/contracts";
import { subscribeJobReady, subscribeQueueResults, type QueueEnqueueResult } from "../lib/store.js";

export interface QueueToastCopy {
  kind: "success" | "error" | "none";
  title: string;
  description?: string;
}

function batchNoun(command: QueueEnqueueResult["command"]): string {
  if (command === "dispatch-scene") return "shots";
  if (command === "generate-main-photo") return "previews";
  if (command === "generate-character-looks") return "looks";
  if (command === "generate-missing-tiles" || command === "regenerate-tile" || command === "establish-look") {
    return "references";
  }
  return "generations";
}

export function queueToastCopy(result: QueueEnqueueResult): QueueToastCopy {
  if (result.disposition === "not-queued") return { kind: "none", title: "" };
  const accepted = result.acceptedJobIds.length;
  if (result.disposition === "accepted") {
    if (result.command === "generate-character-sheet") {
      return {
        kind: "success",
        title: result.characterName
          ? `Character sheet for ${result.characterName} is queued for generation`
          : "Character sheet is queued for generation",
      };
    }
    return {
      kind: "success",
      title:
        accepted === 1 ? "Added to Activity" : `${accepted} ${batchNoun(result.command)} added to Activity`,
    };
  }
  const description = result.failures
    .map((failure) => failure.reason)
    .filter((reason, i, all) => all.indexOf(reason) === i)
    .join(" ");
  if (result.disposition === "partial") {
    return {
      kind: "error",
      title: `${accepted} of ${result.requestedCount} ${batchNoun(result.command)} added to Activity`,
      ...(description ? { description } : {}),
    };
  }
  return {
    kind: "error",
    title: "Couldn’t add this to Activity",
    ...(description ? { description } : {}),
  };
}

export function jobReadyToastCopy(job: Job): QueueToastCopy {
  if (job.target.kind !== "character-sheet") return { kind: "none", title: "" };
  const characterName = typeof job.params["characterName"] === "string" ? job.params["characterName"] : null;
  return {
    kind: "success",
    title: characterName ? `Character sheet for ${characterName} is ready` : "Character sheet is ready",
  };
}

export function QueueToaster() {
  const navigate = useNavigate();

  useEffect(
    () =>
      subscribeQueueResults((result) => {
        const copy = queueToastCopy(result);
        if (copy.kind === "none") return;
        const options = {
          ...(copy.description ? { description: copy.description } : {}),
          action: { label: "Activity", onClick: () => navigate("/activity") },
        };
        if (copy.kind === "success") toast.success(copy.title, options);
        else toast.error(copy.title, options);
      }),
    [navigate],
  );

  useEffect(
    () =>
      subscribeJobReady((job) => {
        const copy = jobReadyToastCopy(job);
        if (copy.kind === "none") return;
        const sheetId = job.target.id?.split("/")[0];
        toast.success(copy.title, {
          action: sheetId
            ? {
                label: "View",
                onClick: () => navigate(`/w/${job.worldId}/cast/${sheetId}/kit`),
              }
            : { label: "Activity", onClick: () => navigate("/activity") },
        });
      }),
    [navigate],
  );

  return (
    <Toaster
      position="top-center"
      offset={{ top: "calc(44px + var(--space-3))" }}
      closeButton
      hotkey={["altKey", "KeyT"]}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "fy-toast",
          title: "fy-toast__title",
          description: "fy-toast__description",
          actionButton: "fy-toast__action",
          closeButton: "fy-toast__close",
          error: "fy-toast--error",
          success: "fy-toast--success",
        },
      }}
    />
  );
}
