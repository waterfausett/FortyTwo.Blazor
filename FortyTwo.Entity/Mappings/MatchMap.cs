using FortyTwo.Entity.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FortyTwo.Entity.Mappings
{

    internal class MatchMap : IEntityTypeConfiguration<Match>
    {
        public void Configure(EntityTypeBuilder<Match> builder)
        {
            builder.ToTable("matches");

            builder.Property(x => x.Id)
                .HasColumnName("id");

            builder.HasKey(x => x.Id);

            builder.Property(x => x.CreatedOn)
                .HasColumnName("created_on")
                .IsRequired();

            builder.Property(x => x.UpdatedOn)
                .HasColumnName("updated_on")
                .IsRequired();

            builder.Property(x => x.CurrentGame)
                .HasColumnName("current_game_json");

            builder.Property(x => x.Games)
                .HasColumnName("games_json");

            builder.Property(x => x.WinningTeam)
                .HasColumnName("winning_team");

            // Relationships
            builder.HasMany(x => x.Players).WithOne(x => x.Match).HasForeignKey(x => x.MatchId);

            // Indexes
            builder.HasIndex(x => new { x.CreatedOn })
                .IsClustered(false);

            builder.HasIndex(x => new { x.UpdatedOn })
                .IsClustered(false);

            builder.HasIndex(x => new { x.CreatedOn })
                .IsClustered(false);
        }
    }
}