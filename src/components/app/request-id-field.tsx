"use client";

import { memo, useEffect, useRef } from "react";

/**
 * A hidden field with an id made once per visit to a create form, so the
 * server can tell a retry of the same submission (e.g. after a lost
 * response) from a new one. Set after mounting, so server and browser render
 * the same markup. Memoised: a hidden input's value is its attribute, so a
 * re-render re-applying defaultValue would wipe the id (forms whose parent
 * re-renders, like the Word import review, would then send none).
 */
export const RequestIdField = memo(function RequestIdField({ name = "request_id" }: { name?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.value) ref.current.value = crypto.randomUUID();
  }, []);
  return <input ref={ref} type="hidden" name={name} defaultValue="" />;
});
