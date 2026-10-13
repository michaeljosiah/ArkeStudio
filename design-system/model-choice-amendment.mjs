// Author-approved amendment, 13 October 2026: retain the provider mark; remove the choice bullet.
export function amendModelChoice(turn) {
  return turn.replaceAll('<span class="dot"></span>', '')
    .replace('a dot when the choice is this chat&#8217;s alone; ', '')
    .replace('; the dot before the mark still says the choice is this chat&#8217;s alone.', '. A chat-specific choice is identified by the picker&#8217;s saved-choice actions, without a bullet before the provider mark.');
}
