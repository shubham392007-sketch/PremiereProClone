/** Shared layout / interaction constants for the timeline feature. */

export const HEADER_WIDTH = 172;
export const RULER_HEIGHT = 28;
/** Extra scrollable room below the last track row. */
export const BOTTOM_PADDING = 88;

export const CLIP_VERTICAL_PADDING = 2;
export const MIN_CLIP_WIDTH = 3;
export const CLIP_LABEL_MIN_WIDTH = 46;
export const CLIP_TIMECODE_MIN_WIDTH = 92;

export const SNAP_THRESHOLD_PX = 7;
export const DRAG_THRESHOLD_PX = 3;

export const MIN_TRACK_HEIGHT = 36;
export const MAX_TRACK_HEIGHT = 200;
export const SMALL_TRACK_HEIGHT = 40;
export const LARGE_TRACK_HEIGHT = 96;
export const VIDEO_TRACK_HEIGHT = 62;
export const AUDIO_TRACK_HEIGHT = 52;

export const MIN_ZOOM = 2;
export const MAX_ZOOM = 4000;
/** Guard against absurdly wide scroll surfaces on very long sequences. */
export const MAX_CONTENT_WIDTH = 20_000_000;

export const EDGE_SCROLL_PX = 40;
export const EDGE_SCROLL_MAX_STEP = 18;

/** DataTransfer MIME used by the media library when dragging an asset. */
export const MEDIA_DRAG_MIME = 'application/x-premiere-media';

export const PLAYHEAD_COLOR = '#5aa8ff';
export const SNAP_COLOR = '#e8c15a';

export const EMPTY_CLIPS: import('@/types').TimelineClip[] = [];
export const EMPTY_SELECTION: string[] = [];
