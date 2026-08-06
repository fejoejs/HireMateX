'use client';

import React from 'react';
import ProfileSetupWizard from '@/components/ProfileSetupWizard';
import { useRouter } from 'next/navigation';

export default function ProfileSetupPage() {
  const router = useRouter();
  
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <ProfileSetupWizard onComplete={() => router.push('/dashboard')} />
    </div>
  );
}
