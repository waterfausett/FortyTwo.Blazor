using FortyTwo.Entity.Mappings;
using FortyTwo.Entity.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Npgsql;

namespace FortyTwo.Entity
{
    public class DatabaseContext : DbContext
    {
        public DatabaseContext(IConfiguration configuration)
            : base(new DbContextOptionsBuilder().UseNpgsql(new NpgsqlConnection(configuration["FortyTwo:DatabaseConnectionString"]),
                options => options.EnableRetryOnFailure()).Options)
        { }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.ApplyConfiguration(new MatchMap());
            modelBuilder.ApplyConfiguration(new MatchPlayerMap());
        }

        public DbSet<Match> Matches { get; set; }
        public DbSet<Match> MatchPlayers { get; set; }
    }
}