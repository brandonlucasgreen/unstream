import { useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { ArtistSettingsContext } from '../pages/ArtistSettingsLayout';

/**
 * Each page already loads the artist's name with its own data; this hands it up to the header.
 * Outside the layout (a test rendering one page) it does nothing.
 */
export function useReportArtistName(name: string | undefined) {
  const context = useOutletContext<ArtistSettingsContext | undefined>();
  useEffect(() => {
    if (name) context?.setArtistName(name);
  }, [context, name]);
}
