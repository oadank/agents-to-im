import {
  STREAM_ELEMENT_ID,
  STREAM_PLACEHOLDER_TEXT,
} from '../constants.js';

export function buildStreamingCardSkeleton(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 1 },
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '',
          element_id: STREAM_ELEMENT_ID,
        },
      ],
    },
  };
}
