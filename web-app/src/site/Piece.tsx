import { useEffect, useRef } from 'react';
import { renderPiece } from './render';
import type { Stroke } from '../types';

export function Piece({ strokes, width, height, className }: { strokes: Stroke[]; width: number; height: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => { if (ref.current) renderPiece(ref.current, strokes, width, height); }, [strokes, width, height]);
  return <canvas ref={ref} className={className} style={{ width, height, display: 'block' }} />;
}
