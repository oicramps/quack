// Just the parts of the extension API the panel touches.
const store: Record<string, unknown> = {};

export function seedStorage(values: Record<string, unknown>) {
  Object.assign(store, values);
}

export const browser = {
  storage: {
    local: {
      async get(key: string) {
        return { [key]: store[key] };
      },
      async set(values: Record<string, unknown>) {
        Object.assign(store, values);
      },
    },
  },
  tabs: {
    async update(props: { url?: string }) {
      console.log('navigate to', props.url);
    },
  },
};
