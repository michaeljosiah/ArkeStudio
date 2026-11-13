import { lazy, type ComponentType } from "react";

/**
 * A component whose module loads on demand: its own chunk, kept out of the start-up script
 * (issue 2797). Until its module arrives it suspends to the nearest `<Suspense>`; once it has
 * arrived it renders synchronously, as a statically imported component would, so a screen that
 * was preloaded never shows a loader and `renderToString` can draw it.
 */
export type Preloadable<P extends object> = ComponentType<P> & { preload(): Promise<ComponentType<P>> };

const registered: Array<() => Promise<unknown>> = [];
const retries: Array<() => void> = [];

export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>): Preloadable<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  let failed = false;
  // A chunk that failed to arrive fails its screen to the route's boundary, and is asked for again
  // when the person next navigates (`retryFailedScreens`). Not at once: React retries a suspended
  // screen whenever its load settles, so asking again straight away would ask, and fail, for as long
  // as the connection is down. React's `lazy` keeps a rejection for good, so the retry makes the lazy
  // component afresh (codex on PR 2858).
  const preload = () => (pending ??= load().then((component) => (loaded = component), (error: unknown) => { pending = undefined; failed = true; throw error; }));
  const suspending = () => lazy(async () => ({ default: await preload() }));
  let Lazy = suspending();
  function Loaded(props: P) {
    const Component = loaded;
    return Component ? <Component {...props} /> : <Lazy {...props} />;
  }
  registered.push(preload);
  retries.push(() => { if (failed) { failed = false; Lazy = suspending(); } });
  return Object.assign(Loaded, { preload });
}

/** Lets each screen whose chunk failed to arrive ask for it again: on navigation, by the route boundary. */
export function retryFailedScreens(): void {
  for (const retry of retries) retry();
}

/** Loads every preloadable made so far: after start-up, so the next screen is already here. */
export function preloadScreens(): Promise<unknown> {
  return Promise.all(registered.map((preload) => preload()));
}
