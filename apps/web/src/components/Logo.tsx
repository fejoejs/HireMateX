import React from 'react';
import { Bot } from 'lucide-react';

interface LogoProps {
  className?: string;
}

export function Logo({ className = "w-8 h-8 text-purple-500" }: LogoProps) {
  return <Bot className={className} />;
}
