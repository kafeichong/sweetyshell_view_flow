'use client';

import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface LightboxImage {
  id: string;
  src: string;
  alt: string;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export function ImageLightbox({ images, index, onIndexChange, onClose }: ImageLightboxProps) {
  const touchStartX = useRef<number | null>(null);
  const image = index === null ? null : images[index];

  const changeImage = (direction: number) => {
    if (index === null || images.length < 2) return;
    onIndexChange((index + direction + images.length) % images.length);
  };

  useEffect(() => {
    if (!image) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') changeImage(-1);
      if (event.key === 'ArrowRight') changeImage(1);
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [image, index, images.length, onClose]);

  if (!image) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="image-lightbox-title"
      onClick={onClose}
      onTouchStart={(event) => {
        touchStartX.current = event.changedTouches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        if (touchStartX.current === null) return;
        const distance = event.changedTouches[0].clientX - touchStartX.current;
        if (Math.abs(distance) >= 50) changeImage(distance > 0 ? -1 : 1);
        touchStartX.current = null;
      }}
    >
      <div
        className="relative flex max-h-full max-w-full items-center justify-center"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="image-lightbox-title" className="sr-only">图片预览</h2>
        <img
          src={image.src}
          alt={image.alt}
          className="max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] object-contain"
        />
        {images.length > 1 && (
          <>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="absolute left-2 top-1/2 -translate-y-1/2"
              aria-label="上一张图片"
              title="上一张"
              onClick={() => changeImage(-1)}
            >
              <ChevronLeft className="size-5" />
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="absolute right-2 top-1/2 -translate-y-1/2"
              aria-label="下一张图片"
              title="下一张"
              onClick={() => changeImage(1)}
            >
              <ChevronRight className="size-5" />
            </Button>
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md border bg-background/90 px-3 py-1 text-sm">
              {(index ?? 0) + 1} / {images.length}
            </div>
          </>
        )}
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="absolute right-2 top-2"
          aria-label="关闭图片预览"
          title="关闭"
          autoFocus
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
