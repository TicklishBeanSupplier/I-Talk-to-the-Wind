import { useEffect, useState } from "react";
import { personKey } from "../core/inbox";
import type { PersonProfile, PersonRef } from "../core/types";
import { errorMessage } from "../platforms/types";
import { useApp } from "../app/store";

/** Profiles are cached for the session: they rarely change while you work. */
const cache = new Map<string, Promise<PersonProfile>>();

export function forgetProfile(person: PersonRef) {
  cache.delete(personKey(person));
}

function load(person: PersonRef): Promise<PersonProfile> {
  const key = personKey(person);
  let p = cache.get(key);
  if (!p) {
    const adapter = useApp.getState().adapters[person.platform];
    p = adapter ? adapter.profile(person) : Promise.resolve({ ...person, postsVisible: false });
    // A failed lookup shouldn't stick; next visit tries again.
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

export function useProfile(person: PersonRef | undefined, version = 0) {
  const [state, setState] = useState<{ profile?: PersonProfile; error?: string; loading: boolean }>({ loading: !!person });
  const key = person ? personKey(person) : "";
  useEffect(() => {
    if (!person) return;
    let live = true;
    setState({ loading: true });
    load(person).then(
      (profile) => live && setState({ profile, loading: false }),
      (err) => live && setState({ error: errorMessage(err), loading: false, profile: { ...person, postsVisible: false } }),
    );
    return () => {
      live = false;
    };
    // `person` is identified by its key; `version` forces a reload after following.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
  return state;
}
