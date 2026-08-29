import { ErrorBoundary as SolidErrorBoundary } from 'solid-js'

export default function ErrorBoundary(props) {
  return (
    <SolidErrorBoundary
      fallback={(error, reset) => (
        <main class="error-screen" role="alert">
          <h1>Đã xảy ra lỗi</h1>
          <p>{error.message}</p>
          <button type="button" class="primary-btn" onClick={reset}>
            Thử lại
          </button>
        </main>
      )}
    >
      {props.children}
    </SolidErrorBoundary>
  )
}
