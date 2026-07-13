import React from "react";

// A last-resort React error boundary. Pulse runs for days as an always-on-top,
// frameless widget with no browser chrome, no console, and no reload — an
// uncaught render throw would otherwise unmount the whole tree to a blank,
// dead pane the user can only kill from the tray. This catches that throw and
// paints a minimal, self-contained neutral fallback with a Reload escape hatch.
//
// The fallback is deliberately dependency-free: house-token classes only, no
// icons, no motion, no backend calls — it must never itself throw.

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // The only diagnostic surface a chromeless widget has left once it throws.
    console.error("Pulse render error:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-surface p-4 text-center text-fg">
          <p className="text-sm text-muted">Something went wrong.</p>
          <button
            type="button"
            onClick={() => location.reload()}
            className="rounded-md bg-fg px-3 py-1 text-sm text-surface"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
