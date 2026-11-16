/**
 * Een productfoto. Breedte en hoogte staan erop, zodat de pagina niet verspringt als de foto
 * binnenkomt. De belangrijkste foto (bovenaan de pagina) laadt meteen en met voorrang; de rest
 * pas als hij in beeld komt.
 */
export function ProductAfbeelding({
  src,
  alt,
  belangrijk = false,
  className,
}: {
  src: string | null;
  alt: string;
  belangrijk?: boolean;
  className?: string;
}) {
  if (!src) {
    return <div className={`aspect-square rounded-md bg-muted ${className ?? ""}`} aria-hidden />;
  }
  return (
    <img
      src={src}
      alt={alt}
      width={800}
      height={800}
      loading={belangrijk ? "eager" : "lazy"}
      fetchPriority={belangrijk ? "high" : "auto"}
      decoding="async"
      className={`aspect-square w-full rounded-md bg-muted object-cover ${className ?? ""}`}
    />
  );
}
