import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useProjectStore } from '@/stores/project-store';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

/** Last-resort boundary so a rendering bug never leaves a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Editor render error:', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private handleReturnHome = (): void => {
    try {
      useProjectStore.getState().closeProject();
    } catch {
      /* ignore */
    }
    this.setState({ error: null, componentStack: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#181818] p-6">
        <div className="w-full max-w-[560px] border border-[#5d3a3a] bg-[#221c1c] p-5">
          <div className="mb-3 flex items-center gap-2 text-[#ff9b9b]">
            <AlertTriangle size={18} />
            <h1 className="text-sm font-semibold">The editor hit an unexpected error</h1>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-app-textDim">
            Your project is safe in local storage and autosave continues to protect saved work. You can reload the
            application or return to the project list.
          </p>
          <pre className="mb-4 max-h-40 overflow-auto whitespace-pre-wrap border border-[#3d2a2a] bg-[#1a1616] p-2 text-2xs text-[#e0b4b4]">
            {this.state.error.message}
            {this.state.componentStack ? `\n${this.state.componentStack}` : ''}
          </pre>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
              <RefreshCw size={13} /> Reload Editor
            </button>
            <button type="button" className="btn" onClick={this.handleReturnHome}>
              Return to Projects
            </button>
          </div>
        </div>
      </div>
    );
  }
}
