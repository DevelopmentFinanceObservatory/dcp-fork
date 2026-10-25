// @vitest-environment jsdom

/**
 * Render-level check that the observation preview (DataPreview) is wired
 * into the definite-result layout — the store/viewModel plumbing itself is
 * covered elsewhere (specStore.test.ts, DataPreview would need its own unit
 * tests if it grew logic). Uses a private store instance (not the app
 * singleton) built on a stub transport that resolves instantly, so the
 * streaming resolve settles fast without fake timers.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createSpecStore } from './lib/store/specStore';
import { definiteExact } from './lib/fixtures';

// vi.mock is hoisted above these imports, so SearchClient's own
// `import { useSpecStore } from './lib/store'` resolves to this instance.
// The stub transport is built INSIDE the factory (rather than a module-level
// class) to sidestep vi.mock's hoisting TDZ -- `definiteExact` is safe to
// close over since import bindings, unlike top-level consts/classes, are
// hoisted along with the mock call itself.
vi.mock('./lib/store', () => {
  class StubTransport {
    async resolve() {
      return definiteExact;
    }
  }
  return { useSpecStore: createSpecStore(new StubTransport()) };
});

import SearchClient from './SearchClient';

describe('<SearchClient> — data preview', () => {
  it('renders DataPreview under a definite result', async () => {
    render(<SearchClient />);

    fireEvent.change(screen.getByLabelText(/describe the data you want/i), {
      target: { value: 'women in Kenya' }, // routes to definite-exact, which carries observations
    });
    fireEvent.submit(screen.getByRole('search'));

    await waitFor(() => expect(screen.getByRole('region', { name: /data preview/i })).toBeInTheDocument());
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });
});
