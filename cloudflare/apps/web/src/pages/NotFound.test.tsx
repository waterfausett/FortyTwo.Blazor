import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { NotFound } from './NotFound';

describe('NotFound', () => {
  it('catches an unknown path and links back to the Lobby', () => {
    render(
      <MemoryRouter initialEntries={['/no/such/page']}>
        <Routes>
          <Route path="/" element={<p>lobby</p>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the Lobby' }).getAttribute('href')).toBe('/');
  });
});
