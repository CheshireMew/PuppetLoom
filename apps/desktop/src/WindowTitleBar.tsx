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
      <div className="window-titlebar-drag" title="拖动窗口">
        <span className="window-titlebar-mark" aria-hidden="true"><Layers3 /></span>
        <span className="window-titlebar-title">{title}</span>
      </div>
      <div className="window-titlebar-controls" aria-label="窗口控制">
        <button type="button" aria-label="最小化窗口" title="最小化" disabled={!state.minimizable} onClick={() => void act("minimize")}><Minus aria-hidden="true" /></button>
        <button type="button" aria-label={state.maximized ? "还原窗口" : "最大化窗口"} title={state.maximized ? "还原" : "最大化"} disabled={!state.maximizable} onClick={() => void act("toggle-maximize")}>{state.maximized ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}</button>
        <button type="button" className="window-titlebar-close" aria-label="关闭窗口" title="关闭" disabled={!state.closable} onClick={() => void act("close")}><X aria-hidden="true" /></button>
      </div>
    </div>
  );
}
