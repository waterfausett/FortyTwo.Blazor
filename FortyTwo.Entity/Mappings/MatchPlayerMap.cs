using FortyTwo.Entity.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FortyTwo.Entity.Mappings
{
    internal class MatchPlayerMap : IEntityTypeConfiguration<MatchPlayer>
    {
        public void Configure(EntityTypeBuilder<MatchPlayer> builder)
        {
            builder.ToTable("match_players");

            builder.HasKey(x => x.Id);

            builder.Property(x => x.MatchId)
                .HasColumnName("match_id")
                .IsRequired();

            builder.Property(x => x.PlayerId)
                .HasColumnName("player_id")
                .IsRequired();

            builder.Property(x => x.Position)
                .HasColumnName("position")
                .IsRequired();

            builder.Property(x => x.Ready)
                .HasColumnName("is_ready")
                .IsRequired();

            // Relationships
            builder.HasOne(x => x.Match)
                .WithMany(x => x.Players);

            // Indexes
            builder.HasIndex(x => x.MatchId)
                .IsClustered(false);

            builder.HasIndex(x => x.PlayerId)
                .IsClustered(false);
        }
    }
}