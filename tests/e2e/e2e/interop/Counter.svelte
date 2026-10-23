<script lang="ts">
  let { count, onlike }: { count: number; onlike: (detail: unknown) => void } = $props();
</script>

<acme-counter {count} onlike-click={(event: CustomEvent) => onlike(event.detail)}></acme-counter>
