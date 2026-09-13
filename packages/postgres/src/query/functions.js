import { qualified } from '../schema/sql.js';

/** Immutable, catalog-checked helpers shared by filters, projections and ordering.
 * Keys use supported BSON type ranks, terminated recursive arrays and UTF8 text,
 * and fixed-width IEEE754 bytes with a sign transform and canonical numeric zero.
 * PostgreSQL text cannot contain NUL, so its zero terminator preserves prefix order.
 */
export const queryFunctions = (schema) => {
  const call = (name) => qualified(schema, name);
  const fn = (name, args, returns, body) => ({ name, arguments: args, returns, body, language: 'plpgsql', volatility: 'IMMUTABLE', configuration: ['search_path=pg_catalog', 'TimeZone=UTC', 'DateStyle=ISO, YMD'] });
  return [
    fn('__simfinity_date_value', ['jsonb'], 'jsonb', `DECLARE __parts integer[]; __year integer; __mapped integer; BEGIN
  IF $1 IS NULL OR $1 = 'null'::jsonb THEN RETURN $1; END IF;
  IF jsonb_typeof($1) = 'array' THEN RETURN (SELECT COALESCE(jsonb_agg(${call('__simfinity_date_value')}(value) ORDER BY position), '[]'::jsonb) FROM jsonb_array_elements($1) WITH ORDINALITY e(value, position)); END IF;
  __parts := regexp_match($1 #>> '{}', '^([+-]?[0-9]+)-([0-9]+)-([0-9]+)T([0-9]+):([0-9]+):([0-9]+)[.]([0-9]+)Z$')::integer[];
  __year := __parts[1]; __mapped := 2000 + ((__year % 400 + 400) % 400);
  RETURN to_jsonb(((make_date(__mapped, __parts[2], __parts[3]) - DATE '1970-01-01')::bigint + ((__year - __mapped)::bigint / 400) * 146097) * 86400000 + __parts[4]::bigint * 3600000 + __parts[5]::bigint * 60000 + __parts[6]::bigint * 1000 + __parts[7]);
END`),
    fn('__simfinity_value_key', ['jsonb', 'text'], 'bytea', `DECLARE __kind text; __bytes bytea; __result bytea; __item jsonb; __number double precision; __index integer; BEGIN
  IF $1 IS NULL OR $1 = 'null'::jsonb THEN RETURN decode('10', 'hex'); END IF;
  __kind := jsonb_typeof($1);
  IF __kind = 'array' THEN
    __result := decode('40', 'hex');
    FOR __item IN SELECT value FROM jsonb_array_elements($1) WITH ORDINALITY e(value, position) ORDER BY position LOOP __result := __result || ${call('__simfinity_value_key')}(__item, $2); END LOOP;
    RETURN __result || decode('00', 'hex');
  ELSIF __kind = 'number' THEN
    __number := ($1 #>> '{}')::double precision;
    IF __number = 0 THEN __number := 0; END IF;
    __bytes := float8send(__number);
    IF get_byte(__bytes, 0) >= 128 THEN
      FOR __index IN 0..7 LOOP __bytes := set_byte(__bytes, __index, 255 - get_byte(__bytes, __index)); END LOOP;
    ELSE __bytes := set_byte(__bytes, 0, get_byte(__bytes, 0) + 128); END IF;
    RETURN decode(CASE WHEN $2 = 'DateTime' THEN '70' ELSE '20' END, 'hex') || __bytes;
  ELSIF __kind = 'string' THEN RETURN decode(CASE WHEN $2 = 'ID' THEN '50' ELSE '30' END, 'hex') || convert_to($1 #>> '{}', 'UTF8') || decode('00', 'hex');
  ELSIF __kind = 'boolean' THEN RETURN decode(CASE WHEN $1 = 'true'::jsonb THEN '6001' ELSE '6000' END, 'hex');
  END IF;
  RAISE EXCEPTION 'Unsupported query comparison value' USING ERRCODE = '22023';
END`),
    fn('__simfinity_sort_key', ['jsonb', 'text', 'boolean'], 'bytea', `BEGIN
  IF $1 = '[]'::jsonb THEN RETURN decode('01', 'hex'); END IF;
  IF jsonb_typeof($1) = 'array' THEN
    RETURN (SELECT ${call('__simfinity_value_key')}(value, $2) FROM jsonb_array_elements($1) ORDER BY CASE WHEN $3 THEN ${call('__simfinity_value_key')}(value, $2) END ASC, CASE WHEN NOT $3 THEN ${call('__simfinity_value_key')}(value, $2) END DESC LIMIT 1);
  END IF;
  RETURN ${call('__simfinity_value_key')}($1, $2);
END`),
  ];
};
