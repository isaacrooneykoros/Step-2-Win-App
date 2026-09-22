export function AuthLogo() {
  return (
    <div className="flex items-center gap-2.5 mb-9">
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        style={{
          background: 'linear-gradient(135deg, #22C55E 0%, #4F9CF9 100%)',
          boxShadow: '0 10px 24px rgba(34,197,94,0.2)',
        }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path
            d="M13 4C13 4 15 7 15 10C15 13 13 15 10 16C9 16.3 8 17 8 18C8 19 9 20 11 20C13 20 15 19 17 17"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="8" cy="10" r="2" fill="white" />
          <circle cx="16" cy="14" r="1.5" fill="white" fillOpacity="0.6" />
        </svg>
      </div>

      <div>
        <p
          className="font-extrabold text-lg leading-none"
          style={{ fontFamily: 'Syne, sans-serif', color: '#F0F2F8', letterSpacing: 0 }}>
          Step2Win
        </p>
        <p className="text-[11px] mt-0.5" style={{ color: '#3D4260' }}>
          Admin Portal
        </p>
      </div>
    </div>
  );
}
