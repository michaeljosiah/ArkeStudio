import { orderedShots, type ProductionBundle } from "@arke-studio/contracts";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Search } from "../components/icons.js";
import { Portrait } from "../components/portrait.js";
import { cx } from "../components/ui.js";
import { acceptedTakeId } from "../lib/selectors.js";
import { takeMediaPath } from "../lib/take-presentation.js";

// ---- Generate workspace (11b) ----------------------------------------------

type TakeEpisode = ProductionBundle["episodes"][number];
export type TakeEpisodeOption = Pick<TakeEpisode, "id" | "title" | "scenes"> & { order: number | null };

export const episodeLabel = (episode: TakeEpisodeOption): string =>
  episode.order === null ? episode.title : `${String(episode.order).padStart(2, "0")} · ${episode.title}`;

export function filterTakeEpisodes(episodes: readonly TakeEpisodeOption[], query: string): TakeEpisodeOption[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...episodes];
  return episodes.filter((episode) => {
    const searchable = episode.order === null
      ? episode.title.toLowerCase()
      : `${episode.order} ${String(episode.order).padStart(2, "0")} ${episode.title}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

/** The first accepted picture in an episode, derived from its authored scene order. */
export function episodeThumbnailPath(
  production: ProductionBundle,
  episode: Pick<ProductionBundle["episodes"][number], "scenes">,
): string | null {
  for (const sceneId of episode.scenes) {
    const scene = production.scenes.find((candidate) => candidate.id === sceneId);
    if (scene === undefined) continue;
    for (const shot of orderedShots(scene)) {
      const takeId = acceptedTakeId(production, shot.id);
      const take = takeId === null ? undefined : production.takes.find((candidate) => candidate.id === takeId);
      const path = take === undefined ? null : takeMediaPath(production, take);
      if (path !== null) return path;
    }
  }
  return null;
}

export function EpisodePicker({
  episodes,
  selected,
  production,
  worldSlug,
  disabled,
  onSelect,
}: {
  episodes: readonly TakeEpisodeOption[];
  selected: TakeEpisodeOption;
  production: ProductionBundle;
  worldSlug: string | undefined;
  disabled: boolean;
  onSelect: (episode: TakeEpisodeOption) => void;
}) {
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = filterTakeEpisodes(episodes, query);
  const highlighted = Math.min(active, Math.max(0, matches.length - 1));

  useEffect(() => {
    const row = list.current?.children[highlighted] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const show = () => {
    if (open) return;
    setQuery("");
    setActive(Math.max(0, episodes.findIndex((episode) => episode.id === selected.id)));
    setOpen(true);
  };
  const choose = (episode: TakeEpisodeOption) => {
    setQuery("");
    setOpen(false);
    if (episode.id !== selected.id) onSelect(episode);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      show();
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown" && matches.length > 0) {
      event.preventDefault();
      setActive((index) => (index + 1) % matches.length);
    } else if (event.key === "ArrowUp" && matches.length > 0) {
      event.preventDefault();
      setActive((index) => (index - 1 + matches.length) % matches.length);
    } else if ((event.key === "Enter" || event.key === "Tab") && matches[highlighted] !== undefined) {
      event.preventDefault();
      choose(matches[highlighted]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setOpen(false);
    }
  };

  return (
    <div className="fy-takes__episode-picker">
      <input
        type="text"
        role="combobox"
        aria-label="Episode"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        {...(open && matches[highlighted] !== undefined
          ? { "aria-activedescendant": `${listId}-${matches[highlighted]!.id}` }
          : {})}
        className="fy-takes__episode-input"
        value={open ? query : episodeLabel(selected)}
        title={episodeLabel(selected)}
        disabled={disabled}
        onFocus={show}
        onClick={show}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setQuery("");
          setOpen(false);
        }}
      />
      <span className="fy-takes__episode-search" aria-hidden><Search size={13} /></span>
      {open && (
        <ul ref={list} id={listId} role="listbox" aria-label="Episodes" className="fy-takes__episode-menu">
          {matches.length === 0 ? (
            <li className="fy-takes__episode-empty">No matching episodes</li>
          ) : (
            matches.map((episode, index) => {
              const image = episodeThumbnailPath(production, episode);
              return (
                <li
                  key={episode.id}
                  id={`${listId}-${episode.id}`}
                  role="option"
                  aria-selected={episode.id === selected.id}
                  className={cx("fy-takes__episode-option", index === highlighted && "fy-takes__episode-option--active")}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(episode)}
                >
                  <span className="fy-takes__episode-thumb" aria-hidden>
                    {image === null ? (
                      <span>{episode.order === null ? "UN" : String(episode.order).padStart(2, "0")}</span>
                    ) : (
                      <Portrait worldSlug={worldSlug} path={image} label="" radius={0} loading="lazy" />
                    )}
                  </span>
                  <span className="fy-takes__episode-copy">
                    <strong>{episodeLabel(episode)}</strong>
                    <span>{episode.scenes.length} scene{episode.scenes.length === 1 ? "" : "s"}</span>
                  </span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
