import React from 'react';

interface BrandNameProps {
  className?: string;
}

export function BrandName({ className = "" }: BrandNameProps) {
  return (
    <span className={`tracking-tight ${className}`}>
      HireMate
      <span 
        className="font-black text-transparent bg-clip-text bg-gradient-to-tr from-[#a855f7] to-[#38bdf8] ml-[1px]"
        style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
      >
        X
      </span>
    </span>
  );
}
