import { createClient } from '@supabase/supabase-js';

let instance: any = null;

function getInstance() {
  if (!instance) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase env vars: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    }
    instance = createClient(supabaseUrl, supabaseServiceKey);
  }
  return instance;
}

export const supabaseAdmin = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (
      prop === '$$typeof' ||
      prop === 'then' ||
      prop === 'toJSON' ||
      prop === 'prototype' ||
      prop === 'valueOf' ||
      typeof prop === 'symbol'
    ) {
      return undefined;
    }
    return Reflect.get(getInstance(), prop, receiver);
  }
});

