/**
 * Version of the serialized IR format.
 *
 * 0 means no schema exists yet. Segment S1 (see ROADMAP.md) defines the IR,
 * sets this to 1 and adds the migration hook for older versions.
 */
export const IR_SCHEMA_VERSION = 0;
