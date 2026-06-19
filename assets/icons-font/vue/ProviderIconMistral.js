import { defineComponent, h } from 'vue';

export const ProviderIconMistral = defineComponent({
  name: 'ProviderIconMistral',
  props: {
    class: {
      type: String,
      default: ''
    }
  },
  setup(props, { attrs }) {
    return () => h(
      'svg',
      {
        viewBox: '0 0 20 20',
        
        class: `svgfont ${props.class}`,
        ...attrs
      },
      [
        h('path', {"d": "M3.428 3.4h3.429v3.428h3.429v3.429h-.002 3.431V6.828h3.427V3.4h3.43v13.714H24v3.429H13.714v-3.428h-3.428v-3.429h-3.43v3.428h3.43v3.429H0v-3.429h3.428V3.4zm10.286 13.715h3.428v-3.429h-3.427v3.429z", "fillRule": "evenodd"})
      ]
    );
  }
});
