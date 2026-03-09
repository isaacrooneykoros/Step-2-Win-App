import React from 'react';

interface XPBarProps {
  currentXP: number;
  xpToNext: number;
  level: number;
  xpThisWeek?: number;
  className?: string;
}

export const XPBar: React.FC<XPBarProps> = ({ 
  currentXP, 
  xpToNext, 
  level, 
  xpThisWeek = 0,
  className = '' 
}) => {
  const progress = (currentXP % xpToNext) / xpToNext;
  
  return (
    <div className={`bg-white rounded-3xl p-3.5 shadow-card ${className}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div 
            className="w-7 h-7 rounded-xl flex items-center justify-center text-xs font-black bg-accent-blue text-white"
          >
            {level}
          </div>
          <span className="text-text-secondary text-xs">Level {level}</span>
        </div>
        {xpThisWeek > 0 && (
          <span className="text-accent-blue font-mono text-xs font-bold">
            +{xpThisWeek} XP
          </span>
        )}
      </div>
      
      {/* XP Bar */}
      <div className="h-2 bg-bg-page rounded-full overflow-hidden">
        <div 
          className="xp-bar-fill h-full rounded-full bg-accent-blue"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      
      <p className="text-text-muted text-[10px] mt-1.5 text-right font-mono">
        {currentXP % xpToNext} / {xpToNext} XP to Level {level + 1}
      </p>
    </div>
  );
};
