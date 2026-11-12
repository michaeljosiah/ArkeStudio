import { createContext, useContext } from "react";
import type { StudioConversationClient } from "../lib/studio-assistant.js";

/** Separate from World/Builder conversation ownership and shared application state. */
export const StudioAssistantContext = createContext<StudioConversationClient | null>(null);
export const useStudioAssistant = () => useContext(StudioAssistantContext);
