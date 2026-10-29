// Controlled component acceptance fixture only. Never shipped in the application.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppChrome } from "../packages/client/src/components/chrome.js";
import { SystemPanel } from "../packages/client/src/components/system-panel.js";
import { openSystemPanel } from "../packages/client/src/lib/system-panel.js";
import { __setBridgeForTest, __setStateForTest } from "../packages/client/src/lib/store.js";
import { FIXTURE_STATE } from "../packages/client/test/fixture-state.js";
import { unavailableSystemResources } from "@arke-studio/contracts";
import { references } from "./system-status-240.references.mjs";

const query = new URLSearchParams(location.search), state = query.get('state') ?? 'overview', dark = query.get('theme') === 'dark';
document.documentElement.classList.toggle('dark', dark);
const device = innerWidth < 600 ? 'phone' : innerWidth < 1100 ? 'tablet' : 'desktop';
function publish() {
  const now = Date.now(), old = now - 180_000, gib = 1024 ** 3;
  const resources = unavailableSystemResources(now);
  resources.cpu = { source: 'node-os', state: state === 'unavailable' ? 'unavailable' : 'measured', measuredAt: state === 'unavailable' ? old : now, value: 24 };
  resources.memory = { source: 'node-os', state: state === 'unavailable' ? 'unavailable' : 'measured', measuredAt: state === 'unavailable' ? old : now, value: { usedBytes: Math.round(18.2 * gib), totalBytes: 32 * gib } };
  if (state !== 'unavailable') resources.gpu = { source: 'nvidia-smi', state: 'measured', measuredAt: now, value: [{ index: 0, utilisation: 42, usedBytes: Math.round(7.8 * gib), totalBytes: 12 * gib }] };
  resources.ming = { source: 'host-owner', state: 'measured', measuredAt: now, value: false };
  __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, systemResources: resources, providers: [],
    ollama: { source: 'managed', state: 'ready', url: null, version: null, detail: null },
    storageHealth: { at: now, writing: false, roots: [
      { rootId: 'system', role: 'local-ai', state: state === 'unavailable' ? 'unavailable' : 'measured', source: 'host-provided', limitations: [], pressure: null, forecast: null,
        capacity: state === 'unavailable' ? null : { volumeId: 'system', mappingRevision: 'system', measuredAt: now, availableBytes: 42 * gib, totalBytes: 476 * gib } },
      { rootId: 'media', role: 'generated-media', state: state === 'unavailable' ? 'unavailable' : 'measured', source: 'host-provided', limitations: [], pressure: null, forecast: null,
        capacity: state === 'unavailable' ? null : { volumeId: 'media', mappingRevision: 'media', measuredAt: now, availableBytes: (state === 'warning' ? 6 : 312) * gib, totalBytes: Math.round(1.8 * 1024 ** 4) } },
    ] },
  } }, { connection: state === 'disconnected' ? 'closed' : 'open' });
}
__setBridgeForTest({ appVersion: 'turn240-component-fixture', platform: 'fixture', connect() {}, subscribe() {}, send(json) { if (JSON.parse(json).kind === 'refresh-system-resources') publish(); } });
publish();
function Fixture() {
  useEffect(() => { const timer = setTimeout(openSystemPanel, 0); return () => clearTimeout(timer); }, []);
  return <MemoryRouter><div className="s240-page" dangerouslySetInnerHTML={{ __html: references[device] }} /><div className="native-chrome"><AppChrome back={{ label: device === 'phone' ? 'Chapters' : 'World', to: '/' }} context={device === 'phone' ? undefined : { label: 'Na love or Juju · story' }} /></div><SystemPanel /></MemoryRouter>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
