import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";

interface AppErrorBoundaryProps {
  children: ReactNode;
  fallbackLabel?: string;
  compact?: boolean;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Prevent uncaught React render errors from blanking the workspace.
  }

  private handleReset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.compact) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-4 bg-neutral-950 text-center text-white">
          <p className="text-xs font-medium text-neutral-200">
            {this.props.fallbackLabel || "Preview unavailable"}
          </p>
          <button
            type="button"
            onClick={this.handleReset}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-teal-600 hover:bg-teal-500 text-white text-xs font-medium cursor-pointer transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Retry</span>
          </button>
        </div>
      );
    }

    return (
      <div className="min-h-screen w-full flex items-center justify-center p-6 bg-[#f8faff] dark:bg-[#060918] text-[#0c1026] dark:text-[#f3f5fc]">
        <div className="max-w-sm w-full rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] p-6 text-center shadow-sm space-y-3">
          <h2 className="text-sm font-semibold">
            {this.props.fallbackLabel || "Something interrupted the view"}
          </h2>
          <p className="text-xs text-[#4d597d] dark:text-[#919ec4]">
            Click below to restore the workspace without losing your page.
          </p>
          <button
            type="button"
            onClick={this.handleReset}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-md bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-xs font-semibold cursor-pointer transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Restore Workspace</span>
          </button>
        </div>
      </div>
    );
  }
}
