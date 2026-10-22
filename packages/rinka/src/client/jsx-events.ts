/** イベントハンドラーの props の名前を、`HTMLElementEventMap` のイベントの名前に対応させる。 */
interface EventNames {
  onAbort: "abort";
  onAnimationCancel: "animationcancel";
  onAnimationEnd: "animationend";
  onAnimationIteration: "animationiteration";
  onAnimationStart: "animationstart";
  onBeforeInput: "beforeinput";
  onBeforeToggle: "beforetoggle";
  onBlur: "blur";
  onCancel: "cancel";
  onCanPlay: "canplay";
  onChange: "change";
  onClick: "click";
  onClose: "close";
  onCompositionEnd: "compositionend";
  onCompositionStart: "compositionstart";
  onCompositionUpdate: "compositionupdate";
  onContextMenu: "contextmenu";
  onCopy: "copy";
  onCut: "cut";
  onDblClick: "dblclick";
  onDrag: "drag";
  onDragEnd: "dragend";
  onDragEnter: "dragenter";
  onDragLeave: "dragleave";
  onDragOver: "dragover";
  onDragStart: "dragstart";
  onDrop: "drop";
  onEnded: "ended";
  onError: "error";
  onFocus: "focus";
  onFocusIn: "focusin";
  onFocusOut: "focusout";
  onGotPointerCapture: "gotpointercapture";
  onInput: "input";
  onInvalid: "invalid";
  onKeyDown: "keydown";
  onKeyUp: "keyup";
  onLoad: "load";
  onLoadedData: "loadeddata";
  onLoadedMetadata: "loadedmetadata";
  onLostPointerCapture: "lostpointercapture";
  onMouseDown: "mousedown";
  onMouseEnter: "mouseenter";
  onMouseLeave: "mouseleave";
  onMouseMove: "mousemove";
  onMouseOut: "mouseout";
  onMouseOver: "mouseover";
  onMouseUp: "mouseup";
  onPaste: "paste";
  onPause: "pause";
  onPlay: "play";
  onPlaying: "playing";
  onPointerCancel: "pointercancel";
  onPointerDown: "pointerdown";
  onPointerEnter: "pointerenter";
  onPointerLeave: "pointerleave";
  onPointerMove: "pointermove";
  onPointerOut: "pointerout";
  onPointerOver: "pointerover";
  onPointerUp: "pointerup";
  onReset: "reset";
  onScroll: "scroll";
  onScrollEnd: "scrollend";
  onSeeked: "seeked";
  onSeeking: "seeking";
  onSelect: "select";
  onSubmit: "submit";
  onTimeUpdate: "timeupdate";
  onToggle: "toggle";
  onTouchCancel: "touchcancel";
  onTouchEnd: "touchend";
  onTouchMove: "touchmove";
  onTouchStart: "touchstart";
  onTransitionCancel: "transitioncancel";
  onTransitionEnd: "transitionend";
  onTransitionRun: "transitionrun";
  onTransitionStart: "transitionstart";
  onVolumeChange: "volumechange";
  onWheel: "wheel";
}

/** props の名前の `on` の後ろを小文字にした名前が、対応させたイベントの名前と一致することを確認する。 */
type Checked = {
  [K in keyof EventNames]: K extends `on${infer Rest}`
    ? Lowercase<Rest> extends EventNames[K]
      ? EventNames[K] extends keyof HTMLElementEventMap
        ? true
        : K
      : K
    : K;
}[keyof EventNames];
const checked: Checked = true;
void checked;

/** 要素 `E` のネイティブのタグが受け付けるイベントハンドラーを表す。`currentTarget` は `E` である。 */
export type EventHandlers<E extends Element> = {
  [K in keyof EventNames]?: (
    event: Omit<HTMLElementEventMap[EventNames[K]], "currentTarget"> & {
      readonly currentTarget: E;
    },
  ) => unknown;
};
