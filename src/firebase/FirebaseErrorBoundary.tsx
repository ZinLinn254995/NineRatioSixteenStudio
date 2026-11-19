import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class FirebaseErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error): State {
    let message = error.message || "Unexpected application error.";
    try {
      const parsed = JSON.parse(error.message) as { error?: string; operationType?: string };
      if (parsed && typeof parsed.error === "string") {
        message = parsed.operationType
          ? `Firebase (${parsed.operationType}): ${parsed.error}`
          : parsed.error;
      }
    } catch {
      // keep raw error message
    }
    return { hasError: true, message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Application ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-white text-neutral-950 dark:bg-neutral-950 dark:text-neutral-50">
        <div className="max-w-md w-full rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-5 space-y-3">
          <h2 className="text-sm font-semibold">Something went wrong</h2>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 break-words leading-relaxed">
            {this.state.message}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, message: "" })}
            className="h-9 px-3.5 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold cursor-pointer"
          >
            Continue to Studio
          </button>
        </div>
      </div>
    );
  }
}
