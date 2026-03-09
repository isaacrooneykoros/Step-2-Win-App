import React, { useState, useRef } from 'react';
import { ChevronRight, Zap, Target, Trophy } from 'lucide-react';

interface OnboardingScreenProps {
  onComplete: () => void;
}

export const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ onComplete }) => {
  const [currentSlide, setCurrentSlide] = useState(0);
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);

  const slides = [
    {
      title: 'Welcome to Step2Win',
      subtitle: 'Transform your steps into rewards',
      icon: '👟',
      content: (
        <div className="space-y-8">
          <div className="flex items-center justify-center h-48">
            <div className="relative w-48 h-48">
              {/* Animated SVG ring */}
              <svg viewBox="0 0 240 240" className="w-full h-full">
                <circle
                  cx="120"
                  cy="120"
                  r="100"
                  fill="none"
                  stroke="url(#ringGradient)"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray="628"
                  strokeDashoffset="157"
                  className="animate-spin-slow"
                />
                <defs>
                  <linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#4F9CF9" />
                    <stop offset="100%" stopColor="#A78BFA" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="absolute inset-0 flex items-center justify-center text-5xl">
                👟
              </div>
            </div>
          </div>
          <p className="text-center text-text-secondary">
            Join thousands of users competing in real-time step challenges
          </p>
        </div>
      ),
    },
    {
      title: 'How It Works',
      subtitle: 'Master the game',
      icon: '🎮',
      content: (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="card p-4 hover:shadow-card-hover transition-shadow group">
              <div className="text-3xl mb-3 group-hover:animate-bounce transition">🎯</div>
              <h3 className="font-semibold text-text-primary text-sm">Join Challenge</h3>
              <p className="text-text-secondary text-xs mt-2">Enter a challenge with entry fee</p>
            </div>
            
            <div className="card p-4 hover:shadow-card-hover transition-shadow group">
              <div className="text-3xl mb-3 group-hover:animate-pulse transition">⚡</div>
              <h3 className="font-semibold text-text-primary text-sm">Walk & Compete</h3>
              <p className="text-text-secondary text-xs mt-2">Track steps vs other users</p>
            </div>
            
            <div className="card p-4 hover:shadow-card-hover transition-shadow group">
              <div className="text-3xl mb-3 group-hover:animate-bounce transition">🏆</div>
              <h3 className="font-semibold text-text-primary text-sm">Win Rewards</h3>
              <p className="text-text-secondary text-xs mt-2">Earn cash from prize pool</p>
            </div>
            
            <div className="card p-4 hover:shadow-card-hover transition-shadow group">
              <div className="text-3xl mb-3 group-hover:animate-bounce transition">⭐</div>
              <h3 className="font-semibold text-text-primary text-sm">Gain XP & Levels</h3>
              <p className="text-text-secondary text-xs mt-2">Unlock badges and rank up</p>
            </div>
          </div>
        </div>
      ),
    },
    {
      title: 'Start Your Journey',
      subtitle: 'Ready to compete?',
      icon: '🚀',
      content: (
        <div className="space-y-6">
          <div className="card p-6">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-tint-blue flex items-center justify-center">
                  <Zap className="w-6 h-6 text-accent-blue" />
                </div>
                <div>
                  <h3 className="font-semibold text-text-primary">Get 10 Daily XP</h3>
                  <p className="text-text-secondary text-sm">For logging in each day</p>
                </div>
              </div>
              
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-tint-purple flex items-center justify-center">
                  <Target className="w-6 h-6 text-accent-purple" />
                </div>
                <div>
                  <h3 className="font-semibold text-text-primary">Earn Challenge XP</h3>
                  <p className="text-text-secondary text-sm">+50 XP per completion, +250 per win</p>
                </div>
              </div>
              
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-tint-yellow flex items-center justify-center">
                  <Trophy className="w-6 h-6 text-accent-yellow" />
                </div>
                <div>
                  <h3 className="font-semibold text-text-primary">Level Up Fast</h3>
                  <p className="text-text-secondary text-sm">Reach new ranks: Bronze → Gold → Diamond</p>
                </div>
              </div>
            </div>
          </div>

          <p className="text-center text-text-secondary text-sm">
            Your first challenge awaits in the Challenges tab
          </p>
        </div>
      ),
    },
  ];

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.changedTouches[0].screenX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    touchEndX.current = e.changedTouches[0].screenX;
    handleSwipe();
  };

  const handleSwipe = () => {
    const diff = touchStartX.current - touchEndX.current;
    if (Math.abs(diff) > 50) {
      if (diff > 0) {
        // Swiped left
        setCurrentSlide((prev) => (prev + 1) % slides.length);
      } else {
        // Swiped right
        setCurrentSlide((prev) => (prev - 1 + slides.length) % slides.length);
      }
    }
  };

  const goToSlide = (index: number) => {
    setCurrentSlide(index);
  };

  const slide = slides[currentSlide];

  return (
    <div className="fixed inset-0 bg-bg-page flex flex-col min-h-screen overflow-hidden z-50">
      {/* Content */}
      <div className="relative z-10 flex flex-col flex-1">
        {/* Header */}
        <div className="pt-8 px-6">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-2xl font-bold text-accent-blue">
              Step2Win
            </h1>
            <button
              onClick={onComplete}
              className="text-text-muted hover:text-text-primary transition-colors text-sm font-medium"
            >
              Skip
            </button>
          </div>
        </div>

        {/* Slides Container */}
        <div
          className="relative flex-1 px-6 pb-32 overflow-hidden"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {slides.map((_, idx) => (
            <div
              key={idx}
              className={`absolute inset-x-6 transition-all duration-500 ease-out ${
                idx === currentSlide
                  ? 'opacity-100 translate-x-0'
                  : idx < currentSlide
                  ? 'opacity-0 -translate-x-full'
                  : 'opacity-0 translate-x-full'
              }`}
            >
              <div className="space-y-6">
                {/* Title */}
                <div className="space-y-2">
                  <h2 className="text-4xl font-bold text-text-primary">
                    {slide.title}
                  </h2>
                  <p className="text-text-secondary text-lg">{slide.subtitle}</p>
                </div>

                {/* Slide Content */}
                <div>
                  {slide.content}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Bottom Navigation */}
        <div className="relative z-20 px-6 pb-8">
          {/* Progress Dots */}
          <div className="flex justify-center gap-2 mb-6">
            {slides.map((_, idx) => (
              <button
                key={idx}
                onClick={() => goToSlide(idx)}
                className={`transition-all duration-300 rounded-full ${
                  idx === currentSlide
                    ? 'w-8 h-3 bg-accent-blue'
                    : 'w-3 h-3 bg-border hover:bg-text-muted'
                }`}
              />
            ))}
          </div>

          {/* Navigation Buttons */}
          <div className="flex gap-3">
            {currentSlide > 0 && (
              <button
                onClick={() => goToSlide(currentSlide - 1)}
                className="flex-1 px-6 py-3 rounded-xl border border-border text-text-primary font-semibold transition-all hover:border-text-secondary hover:bg-gray-50"
              >
                Back
              </button>
            )}
            
            {currentSlide < slides.length - 1 ? (
              <button
                onClick={() => goToSlide(currentSlide + 1)}
                className="flex-1 px-6 py-3 rounded-xl text-white font-semibold transition-all hover:shadow-lg flex items-center justify-center gap-2 group"
                style={{ background: '#4F9CF9', boxShadow: '0 4px 12px rgba(79,156,249,0.3)' }}
              >
                Next
                <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </button>
            ) : (
              <button
                onClick={onComplete}
                className="flex-1 px-6 py-3 rounded-xl text-white font-semibold transition-all hover:shadow-lg flex items-center justify-center gap-2 group text-lg"
                style={{ background: '#4F9CF9', boxShadow: '0 4px 12px rgba(79,156,249,0.3)' }}
              >
                <span>Start Playing</span>
                <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </button>
            )}
          </div>

          {/* Slide Counter */}
          <p className="text-center text-text-muted text-sm mt-4">
            {currentSlide + 1} / {slides.length}
          </p>
        </div>
      </div>
    </div>
  );
};
