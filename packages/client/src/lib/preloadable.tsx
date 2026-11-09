import { lazy, type ComponentType } from "react";

/**
 * A component whose module loads on demand: its own chunk, kept out of the start-up script
 * (issue 2797). Until its module arrives it suspends to the nearest `<Suspense>`; once it has
 * arrived it renders synchronously, as a statically imported component would, so a screen that
 * was preloaded never shows a loader and `renderToString` can draw it.
 */
export type Preloadable<P extends object> = ComponentType<P> & { preload(): Promise<ComponentType<P>> };

const registered: Array<() => Promise<unknown>> = [];

export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>): Preloadable<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  // A chunk that failed to arrive is asked for again on the next use, not remembered as failed.
  const preload = () => (pending ??= load().then((component) => (loaded = component), (error: unknown) => { pending = undefined; throw error; }));
  const Lazy = lazy(async () => ({ default: await preload() }));
  function Loaded(props: P) {
    const Component = loaded;
    return Component ? <Component {...props} /> : <Lazy {...props} />;
  }
  registered.push(preload);
  return Object.assign(Loaded, { preload });
}

/** Loads every preloadable made so far: after start-up, so the next screen is already here. */
export function preloadScreens(): Promise<unknown> {
  return Promise.all(registered.map((preload) => preload()));
}
