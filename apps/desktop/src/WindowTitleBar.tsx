import { useEffect, useState } from "react";
import { Copy, Layers3, Minus, Square, X } from "lucide-react";
import type { WindowShellAction, WindowShellState } from "../electron/global.js";

const initialState: WindowShellState = {
  strategy: "integrated",
  frame: false,
  maximized: false,
  minimized: false,
  fullScreen: false,
  focused: true,
  resizable: true,
  maximizable: true,
  minimizable: true,
  closable: true,
  outerBounds: { x: 0, y: 0, width: 0, height: 0 },
  contentBounds: { x: 0, y: 0, width: 0, height: 0 }
};

export function WindowTitleBar({ title }: { title: string }): React.JSX.Element {
  const [state, setState] = useState(initialState);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.puppetloom.onWindowShellState((next) => {
      if (active) setState(next);
    });
    void window.puppetloom.windowShellState().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function act(action: WindowShellAction): Promise<void> {
    const next = await window.puppetloom.windowShellAction(action);
    if (next) setState(next);
  }

  return (
    <div
      className={`window-titlebar ${state.focused ? "is-focused" : "is-blurred"}`}
      data-testid="window-titlebar"
      data-window-shell={state.strategy}
      data-window-frame={String(state.frame)}
    >
      <div className="window-titlebar-drag" title="창 드래그">
        <span className="window-titlebar-mark" aria-hidden="true"><Layers3 /></span>
        <span className="window-titlebar-title">{title}</span>
      </div>
      <div className="window-titlebar-controls" aria-label="창 제어">
        <button type="button" aria-label="창 최소화" title="최소화" disabled={!state.minimizable} onClick={() => void act("minimize")}><Minus aria-hidden="true" /></button>
        <button type="button" aria-label={state.maximized ? "창 복원" : "창 최대화"} title={state.maximized ? "복원" : "최대화"} disabled={!state.maximizable} onClick={() => void act("toggle-maximize")}>{state.maximized ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}</button>
        <button type="button" className="window-titlebar-close" aria-label="창 닫기" title="닫기" disabled={!state.closable} onClick={() => void act("close")}><X aria-hidden="true" /></button>
      </div>
    </div>
  );
}
