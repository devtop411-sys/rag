export default function LoginPage() {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">⚡</div>
        <h1 className="login-title">Collider VC</h1>
        <p className="login-subtitle">Sign in with your @collider.vc Google account. You will be asked which account to use.</p>

        <div className="login-btn-wrap">
          <a className="btn btn--primary" href="/auth/google/start">
            Sign in with Google
          </a>
        </div>
      </div>
    </div>
  );
}
