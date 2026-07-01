// Sprite-billboard constants for the in-scene character/mob renderers, ported
// (with the latamvisuais State dependency removed). The fixed render canvas
// pins the feet anchor at a deterministic pixel so the billboard always lines
// up with the projected ground point. URL builders live in ./ragassets.ts.

/** Fallback frame count per animation type — the bare body animation, uniform
 *  across every job and gender. Used until the runtime probe lands the
 *  composited count (an animated costume makes a pose longer than the body). */
export const ACTION_FRAMES: Record<number, number> = {
  0: 3, // idle
  1: 8, // walk
  2: 3, // sit
  3: 3, // pickup
  4: 6, // standby
  5: 5, // attack1
  10: 9, // attack2
  11: 8, // attack3
  12: 6, // casting
  6: 3, // hurt
  7: 1, // frozen
  8: 1, // dead
  9: 1, // frozen2
};

export const SPRITE_FRAMES = (action: number): number => ACTION_FRAMES[action] ?? 1;

/** Fixed render canvas for the player. The origin (feet/ground point) sits at
 *  (anchorX, anchorY) from the top-left. Sized to fit the widest/tallest poses
 *  without clipping (dead lies wide, capes/wings extend far up). */
export const SPRITE = { w: 208, h: 210, anchorX: 104, anchorY: 152 } as const;
export const SPRITE_CANVAS = `${SPRITE.w}x${SPRITE.h}+${SPRITE.anchorX}+${SPRITE.anchorY}`;

/** Sprite-pixel → world scale. roBrowser SpriteRenderer: _size = size / 175 *
 *  xSize, xSize = 5. */
export const UNITS_PER_PX = 5 / 175;

export const SPRITE_IDLE = 0;
export const SPRITE_WALK = 1;
export const SPRITE_SIT = 2;
export const SPRITE_ATTACK1 = 5;
export const SPRITE_HURT = 6;
export const SPRITE_DEAD = 8;
export const SPRITE_ATTACK2 = 10;
export const SPRITE_ATTACK3 = 11;
export const SPRITE_CASTING = 12;
