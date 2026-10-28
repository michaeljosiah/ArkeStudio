import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { NEW_ONBOARDING, componentIsSettled, harnessModelReference, onboardingComponents, onboardingLocalModels,
  onboardingWritingModels, onboardingWritingReadiness, type OnboardingPlan } from "@arke-studio/contracts";
import { ArrowRight, Check, Cloud, Cpu, Folder, Laptop, Mic, Sliders, TriangleAlert } from "../components/icons.js";
import { LaunchFrame } from "./launch.js";
import { VendorSignInRow } from "./shell.js";
import { checkOnboarding, saveOnboarding, useStore, subscribeCommandFailures,
  refreshVendorAuth, listHarnessModels, chooseClaudeExecutable, chooseCodexExecutable,
  setOllamaUrl, useManagedOllama, chooseComfyUiPath, setComfyUiUrl, clearComfyUiEngine,
  chooseComfyUiModelsDir, setupRetry, setupPause, setupResume, setupCancel } from "../lib/store.js";
import { isRemoteSession } from "../lib/remote-session.js";

function Head({ step, title, children }: { step: string; title: string; children: ReactNode }) {
  return <><div className="ij-step">{step}</div><h2 tabIndex={-1}>{title}</h2><p className="ij-lead">{children}</p></>;
}
function Action({ children, onClick, primary = false, disabled = false }: { children: ReactNode; onClick(): void; primary?: boolean; disabled?: boolean }) {
  return <button type="button" className={`ij-button${primary ? " ij-primary" : ""}`} onClick={onClick} disabled={disabled}>{children}{primary && <ArrowRight size={18} />}</button>;
}
function Choice({ title, detail, note, icon, onClick, disabled = false }: { title: ReactNode; detail: string; note?: string; icon: ReactNode; onClick(): void; disabled?: boolean }) {
  return <button type="button" className="ij-choice" onClick={onClick} disabled={disabled}>{icon}<span><strong>{title}</strong><span>{detail}</span>{note && <em>{note}</em>}</span><ArrowRight size={18} /></button>;
}
function Row({ title, detail, state = "Included", icon = <Check size={18} /> }: { title: string; detail: ReactNode; state?: string; icon?: ReactNode }) {
  return <div className="ij-row">{icon}<div><strong>{title}</strong><p>{detail}</p></div><span className="ij-state">{state}</span></div>;
}
const size = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.ceil(mb)} MB`;
const accounts = [{ id: "openai" as const, name: "ChatGPT", detail: "Sign in with your ChatGPT account.", note: "Requires an eligible plan · uses your plan’s allowance" },
  { id: "github-copilot" as const, name: "GitHub Copilot", detail: "Sign in with your GitHub account.", note: "Requires Copilot access · uses your plan’s allowance" }];

/** Approved turns 242–244, backed by existing settings, discovery, sign-in and acquisition owners. */
export function OnboardingScreen() {
  const { state, connection } = useStore();
  const navigate = useNavigate();
  const saved = state?.app.onboarding;
  const [plan, setPlan] = useState<OnboardingPlan>(() => saved?.plan && saved.plan.step !== "done" ? saved.plan : { ...NEW_ONBOARDING });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishing = useRef(false);
  const expectedPlan = useRef<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [ollamaUrl, setOllamaAddress] = useState("http://127.0.0.1:11434");
  const [comfyUrl, setComfyAddress] = useState("http://127.0.0.1:8188");
  const checked = useRef(false);
  useEffect(() => {
    if (connection !== "open" || !state || checked.current || isRemoteSession()) return;
    checked.current = true; checkOnboarding();
  }, [connection, state]);
  useEffect(() => subscribeCommandFailures(event => {
    if (["save-onboarding", "check-onboarding", "set-agent-config", "set-ollama-url", "set-comfyui-url"].includes(event.command)) {
      setError(event.reason); setPending(false); finishing.current = false;
    }
  }), []);
  useEffect(() => {
    if (!saved) return;
    if (finishing.current && saved.plan.step === "done") { navigate("/worlds", { replace: true }); return; }
    if (expectedPlan.current === JSON.stringify(saved.plan)) { setPlan(saved.plan); setPending(false); expectedPlan.current = null; }
  }, [saved]);
  useEffect(() => { panel.current?.querySelector<HTMLElement>("h2")?.focus(); }, [plan.step]);
  const app = state?.app;
  const connected = connection === "open";
  const update = (patch: Partial<OnboardingPlan>, action: "save" | "install" | "finish" = "save") => {
    if (!connected || pending) return;
    const next = { ...plan, ...patch, ...(action === "finish" ? { step: "done" as const } : action === "install" ? { step: "progress" as const } : {}) }; setError(null); if (action !== "finish") setPlan(next); setPending(true);
    expectedPlan.current = JSON.stringify(next);
    finishing.current = action === "finish"; saveOnboarding(next, action);
  };
  const localModels = app ? onboardingLocalModels(app) : [];
  const components = app?.setup?.components ?? [];
  const selected = onboardingComponents(plan, components);
  const missing = selected.filter(c => !componentIsSettled(c.state));
  const downloadMb = missing.reduce((sum, c) => sum + Math.max(0, c.sizeMb - c.bytesDone / 1048576), 0);
  const peakMb = missing.reduce((sum, c) => sum + (c.installedMb ?? c.sizeMb), 0);
  const mediaSupported = app?.runtime?.probes.platform === "win32" && app.runtime.probes.accelerators?.includes("cuda") === true &&
    app.runtime.models.some(m => ["image", "video"].includes(m.capability) && ["runs-well", "runs-slowly"].includes(m.fit ?? ""));
  const voiceSupported = app?.voiceRuntime?.bundledAvailable === true;
  const advanced = plan.persona === "advanced";
  const detected = app?.harness?.harnesses.filter(h => h.id !== "opencode" && h.installed) ?? [];
  const writing = app ? onboardingWritingReadiness(app, plan) : { ready: false, detail: "Connecting to Arke…" };
  const writingModels = app ? onboardingWritingModels(app, plan) : [];
  const connectedAccounts = app?.vendorAuth.vendors.map(v => `${v.id}:${v.connections.length}:${v.needsSignIn}`).join("|");
  useEffect(() => {
    if (["accounts", "account", "progress"].includes(plan.step) && connected) { refreshVendorAuth(); listHarnessModels(); }
  }, [plan.step, connected]);
  useEffect(() => { if (plan.step === "account" && connected) listHarnessModels(); }, [connectedAccounts, connected]);
  useEffect(() => {
    if (plan.step === "account" && !plan.modelId && writingModels.length) setPlan(current => ({ ...current, modelId: harnessModelReference(writingModels[0]!) }));
  }, [plan.step, plan.modelId, writingModels.map(harnessModelReference).join("|")]);
  useEffect(() => {
    if (plan.step !== "check" || pending || !saved?.workspace || !app?.harness) return;
    update({ step: detected.length || advanced ? "assistant" : "writing", media: mediaSupported, voice: !advanced && voiceSupported });
  }, [plan.step, pending, saved?.workspace, app?.harness]);

  const later = () => update({ writing: "none", modelId: null, account: null, step: advanced ? "sources" : plan.persona === "lightweight" ? "lightweight" : "review" });
  const recheck = () => { setError(null); checkOnboarding(); refreshVendorAuth(); listHarnessModels(); };
  const goReview = () => update({ step: advanced ? "sources" : "review" });
  const localCheck = useRef("");
  useEffect(() => {
    const key = `${plan.modelId}:${app?.ollama?.url}`;
    if (plan.step === "progress" && plan.writing === "local" && !missing.some(c => c.engine === "ollama") && app?.ollama?.state === "ready" && localCheck.current !== key) {
      localCheck.current = key; checkOnboarding(); listHarnessModels();
    }
  }, [plan.step, plan.modelId, plan.writing, missing.length, app?.ollama?.state, app?.ollama?.url]);
  const restart = async () => {
    const result = await window.arke?.restartForSetup?.();
    if (result?.reason) setError(result.reason);
  };
  const location = <div className="ij-location"><Folder size={18} /><div><strong>Your Arke folder</strong>
    <span>{saved?.workspace?.path ?? "Checking your workspace…"}{app?.runtime?.probes.diskFreeMb != null ? ` · ${size(app.runtime.probes.diskFreeMb)} free` : ""}</span>
    {saved?.workspace?.detail && <span role="alert">{saved.workspace.detail}</span>}</div>
    <Action onClick={() => { void window.arke?.chooseWorkspaceFolder?.().then(result => { if (result.reason) setError(result.reason); }); }} disabled={!window.arke?.chooseWorkspaceFolder}>Change folder</Action></div>;
  const back = (step: OnboardingPlan["step"]) => <Action onClick={() => update({ step })} disabled={pending}>Back</Action>;
  const enter = <Action primary disabled={pending || !connected || !saved?.workspace?.ready} onClick={() => update({}, "finish")}>Start using Arke</Action>;
  let body: ReactNode;
  if (plan.step === "choose" || plan.step === "done") body = <>
    <Head step="WELCOME · SET UP YOUR STUDIO" title="Make Arke yours.">Choose how much to set up now. You can change this later in Settings.</Head>
    <div className="ij-choices">
      <Choice icon={<Laptop />} title={<>Set it up for me <small>Recommended</small></>} detail="Arke checks your computer and suggests a setup that fits." note="You’ll see any downloads before they start" disabled={pending} onClick={() => update({ persona: "guided", step: "check" })} />
      <Choice icon={<Sliders />} title="Choose my setup" detail="Use your existing assistant, choose capabilities and folders." note="OpenCode included · detected Claude Code or Codex optional" disabled={pending} onClick={() => update({ persona: "advanced", step: "check" })} />
      <Choice icon={<Folder />} title="Start lightweight" detail="Write, organise and use your own media. Add AI later." note="No additional AI downloads" disabled={pending} onClick={() => update({ ...NEW_ONBOARDING, persona: "lightweight", step: "lightweight" })} />
    </div><p className="ij-note">No Arke account is required. Your worlds stay on your computer.</p>
  </>;
  else if (plan.step === "check") body = <>
    <Head step="SET IT UP FOR ME" title="Finding the right setup for you.">Arke is checking your computer and any writing assistants you already use.</Head>
    <Row title="Your computer" detail="Finding writing and creative tools that will work here." state={app?.runtime ? "Checked" : "Checking"} />
    <Row title="Space for your work" detail={saved?.workspace?.detail ?? "Checking where your files and downloads will fit."} state={saved?.workspace?.ready ? "Checked" : "Checking"} />
    <Row title="Existing assistants" detail="Looking for supported installations you can choose to use." state={app?.harness ? "Checked" : "Checking"} />
    <p className="ij-note">Nothing is being downloaded. We’ll only offer options this computer can use.</p>
    <div className="ij-actions"><Action onClick={recheck}>Check again</Action><Action onClick={() => update({ ...NEW_ONBOARDING, persona: "lightweight", step: "lightweight" })}>Start without AI for now</Action></div>
  </>;
  else if (plan.step === "assistant") body = <>
    <Head step={advanced ? "CUSTOM · YOUR WRITING ASSISTANT" : "WE FOUND YOUR ASSISTANTS"} title={advanced ? "Use the assistant you prefer." : "Use what you already have?"}>
      {advanced ? "OpenCode is included with Arke. You can choose a supported assistant already on this computer." : "These supported assistants are installed on this computer. Choose the one you’d like Arke to use."}</Head>
    <fieldset className="ij-options ij-harness"><legend>Your writing assistant</legend>
      {[{ id: "opencode" as const, label: advanced ? "OpenCode" : "Let Arke set it up", installed: true }, ...detected].map(h => <label key={h.id}>
        <input type="radio" name="assistant" checked={plan.harness === h.id} onChange={() => setPlan({ ...plan, harness: h.id })} />
        <span><strong>{h.label}<small>{h.id === "opencode" ? "Included" : "Found on this computer"}</small></strong><span>{h.id === "opencode" ? "Connect an account or use writing support that fits this computer." : "Use this installed assistant and its account."}</span></span>
      </label>)}</fieldset>
    {advanced && <details><summary>Can’t see your installation?</summary><div className="ij-actions"><Action onClick={chooseClaudeExecutable}>Choose Claude Code</Action><Action onClick={chooseCodexExecutable}>Choose Codex</Action><Action onClick={recheck}>Check again</Action></div></details>}
    <p className="ij-note">We’ll check the account before writing help is ready. You can change your assistant later.</p>
    <div className="ij-actions">{back("choose")}<Action primary disabled={pending} onClick={() => {
      update({ writing: plan.harness === "opencode" ? advanced ? "account" : "none" : "existing", modelId: null,
        step: advanced ? "capabilities" : plan.harness === "opencode" ? "writing" : "account" });
    }}>{advanced ? "Choose capabilities" : "Continue"}</Action></div>
  </>;
  else if (plan.step === "writing") body = <>
    <Head step="WRITING HELP · COMPUTER CHECKED" title={localModels.length ? "How would you like writing help?" : "Online writing is a better fit here."}>
      {localModels.length ? "We found writing support that fits this computer. You can also use an online account." : "We couldn’t confirm suitable writing support for this computer. You can still write and organise your worlds."}</Head>
    <div className="ij-choices">
      {localModels.length > 0 && <Choice icon={<Laptop />} title="On this computer" detail="Works offline after setup. A suitable download is available for this computer." disabled={pending} onClick={() => update({ writing: "local", account: null, modelId: localModels[0]!.modelId, step: advanced ? "sources" : "review" })} />}
      <Choice icon={<Cloud />} title="Use an online account" detail="Sign in with ChatGPT or GitHub Copilot. No large writing download." disabled={pending} onClick={() => update({ writing: "account", modelId: null, step: "accounts" })} />
    </div><p className="ij-note">Online writing needs internet access and uses your account’s allowance. Your requests are sent to the service you choose.</p>
    <div className="ij-actions">{back(advanced ? "capabilities" : "choose")}<Action onClick={recheck}>Check again</Action><Action onClick={later}>Set up writing later</Action></div>
  </>;
  else if (plan.step === "accounts") body = <>
    <Head step="AI WRITING AGENT · SIGN IN" title="Set up your AI writing agent.">Choose the account your agent will use to help you plan and write.</Head>
    <div className="ij-choices">{accounts.map(a => <Choice key={a.id} title={a.name} detail={a.detail} note={a.note} icon={<Cloud />} disabled={pending} onClick={() => update({ account: a.id, modelId: null, step: "account" })} />)}
      <Choice title={<>Arke <small>Coming later</small></>} detail="Not available yet." icon={<Cloud />} onClick={() => {}} disabled />
    </div><p className="ij-note">Your writing requests go to the service you choose. You can change this later in Settings.</p>
    <div className="ij-actions">{back("writing")}<Action onClick={later}>Set up writing later</Action></div>
  </>;
  else if (plan.step === "account") {
    const vendor = app?.vendorAuth.vendors.find(v => v.id === plan.account);
    const name = plan.writing === "existing" ? detected.find(h => h.id === plan.harness)?.label ?? plan.harness : accounts.find(a => a.id === plan.account)?.name ?? "your account";
    body = <><Head step="AI WRITING AGENT" title={writing.ready ? "Your AI writing agent is ready." : `Connect ${name}.`}>
      {writing.ready ? "Your account is connected and an available writing model has been checked." : plan.writing === "existing" ? "Use the selected assistant’s account. Arke keeps your choice when you reopen." : "Sign in on the account’s own page, then return here."}</Head>
      {!writing.ready && vendor && !writing.detail.startsWith("Restart Arke") && <div className="ij-block fy-set"><VendorSignInRow vendor={{ ...vendor, methods: vendor.methods.filter(m => m.kind === "oauth") }} signIn={app!.vendorAuth.signIn} linked={false} usedForAuthoring={false} setup /></div>}
      {!writing.ready && !vendor && plan.writing === "account" && <p className="ij-note" role="status">{advanced ? app?.vendorAuth.reason ?? "Checking supported sign-in methods…" : "Account sign-in is not available yet. Check again, or set up writing later."}</p>}
      <Row title={name} detail={writing.detail} state={writing.ready ? "Ready" : "Not ready"} icon={writing.ready ? <Check size={18} /> : <TriangleAlert size={18} />} />
      {writingModels.length > 0 && <div className="ij-field"><label htmlFor="writing-model">{advanced ? "Writing model" : "Writing support available with your account"}</label><select id="writing-model" value={plan.modelId ?? ""} onChange={e => setPlan({ ...plan, modelId: e.target.value })}>
        <option value="" disabled>Choose a model</option>{writingModels.map(m => <option key={harnessModelReference(m)} value={harnessModelReference(m)}>{m.displayName ?? m.id}{m.isDefault ? " · recommended by your provider" : ""}</option>)}</select></div>}
      <p className="ij-note">Your account’s allowance applies. Checking this connection does not generate content.</p>
      <div className="ij-actions"><Action onClick={recheck}>Check again</Action>{back(plan.writing === "existing" ? "assistant" : "accounts")}<Action onClick={later}>Set up writing later</Action>
        {writing.detail.startsWith("Restart Arke") && window.arke?.restartForSetup && <Action primary onClick={() => { void restart(); }}>Restart and continue</Action>}
        <Action primary disabled={pending || !writing.ready} onClick={goReview}>Continue setup</Action></div>
    </>;
  }
  else if (plan.step === "capabilities") body = <>
    <Head step="CUSTOM · 1 OF 3" title="Choose what you need.">Core authoring is included. Select the capabilities to prepare now.</Head>
    <div className="ij-options">
      <label><input type="checkbox" checked={plan.writing !== "none"} onChange={e => setPlan({ ...plan, writing: e.target.checked ? plan.harness === "opencode" ? "account" : "existing" : "none" })} /><span><strong>Writing assistance</strong><span>{plan.harness === "opencode" ? "OpenCode with a cloud provider or Ollama and a local model." : "Your selected assistant and its account."}</span></span></label>
      <label><input type="checkbox" checked={plan.media} onChange={e => setPlan({ ...plan, media: e.target.checked })} /><span><strong>Local images & video</strong><span>ComfyUI. Choose recipe models separately.</span></span></label>
      <label><input type="checkbox" checked={plan.voice} disabled={!voiceSupported} onChange={e => setPlan({ ...plan, voice: e.target.checked })} /><span><strong>Preset voices & dictation</strong><span>{voiceSupported ? "Kokoro and Whisper. No GPU required." : "The bundled voice tools are not available on this computer."}</span></span></label>
    </div><p className="ij-note">Choose sources, models and folders next. Only selected capabilities add downloads or readiness checks.</p>
    <div className="ij-actions">{back("assistant")}<Action primary disabled={pending} onClick={() => update({ step: plan.writing === "none" ? "sources" : plan.harness === "opencode" ? "writing" : "account" })}>Configure selected</Action></div>
  </>;
  else if (plan.step === "sources") body = <>
    <Head step="CUSTOM · 2 OF 3" title="Make it fit your computer.">Arke-managed services are selected by default. Existing services stay under your control.</Head>
    <p className="ij-note">Writing harness: {plan.harness === "opencode" ? "OpenCode · included" : plan.harness}.</p>
    {plan.writing === "local" && <><div className="ij-field"><label htmlFor="local-model">Local text model</label><select id="local-model" value={plan.modelId ?? ""} onChange={e => setPlan({ ...plan, modelId: e.target.value })}>{localModels.map(m => <option key={m.modelId} value={m.modelId}>{m.displayName}</option>)}</select></div>
      <Row title="Local model service · Ollama" detail={app?.ollama?.url ?? "Arke-managed (recommended)"} state={app?.ollama?.source === "user-url" ? "Existing" : "Managed"} />
      <div className="ij-field"><label htmlFor="ollama-url">Existing service address</label><input id="ollama-url" value={ollamaUrl} onChange={e => setOllamaAddress(e.target.value)} /><div className="ij-actions"><Action onClick={() => setOllamaUrl(ollamaUrl)}>Use this service</Action><Action onClick={useManagedOllama}>Use Arke-managed</Action></div></div></>}
    {plan.media && <><Row title="Media engine · ComfyUI" detail={app?.comfyui?.engine.location ?? "Arke-managed (recommended)"} state={app?.comfyui?.engine.source ?? "Managed"} />
      <div className="ij-actions"><Action onClick={clearComfyUiEngine}>Use Arke-managed</Action><Action onClick={chooseComfyUiPath}>Choose existing folder</Action></div>
      <div className="ij-field"><label htmlFor="comfy-url">Existing service address</label><input id="comfy-url" value={comfyUrl} onChange={e => setComfyAddress(e.target.value)} /><div className="ij-actions"><Action onClick={() => setComfyUiUrl(comfyUrl)}>Use this service</Action><Action onClick={chooseComfyUiModelsDir}>Choose model folder</Action></div></div>
      {!mediaSupported && app?.comfyui?.engine.source !== "user-url" && <p className="ij-note">Managed picture and video tools have not been confirmed suitable here. Choose an existing service or leave this capability for later.</p>}</>}
    {location}<details><summary>Advanced</summary><p>Existing services keep their own packages and lifecycle. Manage additional locations and models in Settings.</p></details>
    <div className="ij-actions">{back("capabilities")}<Action primary disabled={pending} onClick={() => update({ step: "review" })}>Review selected setup</Action></div>
  </>;
  else if (plan.step === "review") body = <>
    <Head step={advanced ? "CUSTOM · REVIEW YOUR PLAN" : "GUIDED · REVIEW YOUR PLAN"} title={advanced ? "Just what you chose." : "A good place to start."}>Check your tools and space before starting any downloads.</Head>
    {plan.writing !== "none" && <Row title={plan.writing === "local" ? "Writing help on this computer" : "AI writing agent"} detail={plan.writing === "local" ? localModels.find(m => m.modelId === plan.modelId)?.displayName ?? "Selected local model" : writing.detail} state={writing.ready ? "Ready" : "Set up"} icon={<Laptop size={18} />} />}
    {plan.voice && <Row title="Read aloud & dictation" detail="Hear your words or speak instead of typing." state="Set up" icon={<Mic size={18} />} />}
    {plan.media && <Row title="Picture & video tools" detail="Prepare the tools. Choose recipe downloads later." state="Set up" icon={<Cpu size={18} />} />}
    {location}<div className="ij-facts"><div><span>Download remaining</span><strong>{size(downloadMb)}</strong></div><div><span>Kept on disk</span><strong>{missing.length ? "Not yet measured" : "No extra files"}</strong></div><div><span>Setup space estimate</span><strong>{size(peakMb)}</strong></div></div>
    <p className="ij-note">Only missing selected files count. Setup checks each actual destination before downloading. These catalogue estimates do not guarantee the final installed size.</p>
    {missing.some(c => c.blockedBy === "disk") && <p className="ij-note">Some selected downloads need more space. Their destination and required space are shown below. You can change the selection or start writing while you make room.</p>}
    <details><summary>{advanced ? "Dependencies and destinations" : "Download details"}</summary>{selected.map(c => <Row key={c.id} title={c.displayName} detail={c.installLocation ?? "Managed by the selected service"} state={componentIsSettled(c.state) ? "Already here" : size(c.sizeMb)} />)}</details>
    <div className="ij-actions">{back(advanced ? "capabilities" : "writing")}<Action onClick={recheck}>Check again</Action>
      <Action primary disabled={pending || !saved?.workspace?.ready} onClick={() => update({}, "install")}>{advanced ? "Install selected" : "Set up these tools"}</Action></div>
    <div className="ij-actions">{enter}</div>
  </>;
  else if (plan.step === "progress") {
    const needsAttention = missing.some(c => ["paused", "failed", "blocked"].includes(c.state));
    const ready = missing.length === 0 && (plan.writing === "none" || writing.ready) && (!plan.media || app?.comfyui?.engine.state === "ready") && (!plan.voice || app?.health.voice.status === "healthy");
    body = <><Head step={ready ? "READY TO BEGIN" : needsAttention ? "SETUP · NEEDS ATTENTION" : "SETTING THINGS UP"} title={ready ? "Your studio is ready." : needsAttention ? "Keep going. We’ll keep your place." : "Your studio is taking shape."}>{ready ? "Your selected tools are ready. Let’s make something." : "You can start writing while your selected tools finish setting up."}</Head>
      <Row title="Arke & your data folder" detail={saved?.workspace?.detail ?? "Workspace checked. You can create and save worlds."} state={saved?.workspace?.ready ? "Ready" : "Needs attention"} />
      {plan.writing !== "none" && <Row title="Writing assistant" detail={writing.detail} state={writing.ready ? "Ready" : "Not ready"} />}
      {selected.map(c => <div key={c.id}><Row title={advanced ? c.displayName : c.engine === "ollama" ? "Writing support" : c.engine === "comfyui" ? "Picture & video tools" : "Read aloud & dictation"} detail={c.detail ?? c.purpose} state={componentIsSettled(c.state) ? "Files ready" : c.state} />
        {!componentIsSettled(c.state) && <div className="ij-progress"><progress value={c.bytesDone} max={Math.max(c.bytesTotal, 1)} aria-label={`${c.displayName} download`} /><span>{size(c.bytesDone / 1048576)} of {size(c.bytesTotal / 1048576)}</span>
          {c.pauseSupported && c.state === "downloading" && <Action onClick={() => setupPause(c.id)}>Pause</Action>}{c.state === "paused" && <Action onClick={() => setupResume(c.id)}>Resume</Action>}{["failed", "blocked"].includes(c.state) && <Action onClick={() => setupRetry(c.id)}>Try again</Action>}</div>}
      </div>)}
      <p className="ij-note">Completed downloads are kept. Downloads and next steps remain in Settings. Paused transfers resume only when you ask.</p>
      <div className="ij-actions"><Action onClick={recheck}>Check again</Action><Action onClick={() => update({ step: "review" })}>View download plan</Action>{enter}</div>
      {missing.length > 0 && <details><summary>Download controls</summary><p>Stop cancels all setup downloads, including any started in Settings, and discards their unfinished files. Completed files are kept.</p><Action onClick={setupCancel}>Stop all setup downloads</Action></details>}
    </>;
  }
  else body = <>
    <Head step="LIGHTWEIGHT · READY TO BEGIN" title="Start small. Make something.">Everything you need to write and organise is already in the app.</Head>
    <Row title="Worlds & writing" detail="Create worlds, edit by form and write your stories." />
    <Row title="Your existing media" detail="Import, organise and preview your own files." />
    {app?.sampleWorld.available && <Row title="Sample world" detail={app.sampleWorld.download ? "Explore the optional story download later." : "Explore the sample included with this build."} state={app.sampleWorld.download ? "Optional" : "Included"} />}
    <div className="ij-facts"><div><span>Extra downloads</span><strong>None</strong></div><div><span>Account needed</span><strong>No</strong></div></div>
    <p className="ij-note">Write and organise without an account or internet connection. Add AI help whenever you want it.</p>
    {!saved?.workspace?.ready && <>{location}<Action onClick={recheck}>Check workspace again</Action></>}
    <Action onClick={() => update({ step: "assistant" })}>Set up an AI writing agent</Action>
    <div className="ij-actions">{back("choose")}{enter}</div>
  </>;
  return <div className="ij fy-onboarding" data-screen="onboarding"><LaunchFrame><div className="ij-content" ref={panel}>
    {!connected && <p role="status" className="ij-note">Reconnecting to your studio. Your saved choices are kept.</p>}
    {error && <p role="alert" className="ij-note">{error}</p>}
    {isRemoteSession() ? <><Head step="SET UP ON YOUR COMPUTER" title="Open Arke on your computer.">Installation and account setup are managed there.</Head><Action onClick={() => navigate("/worlds")}>Open worlds</Action></> : body}
    {pending && <p role="status" className="ij-note">Saving your choices…</p>}
  </div></LaunchFrame></div>;
}
