﻿// <auto-generated />
using System;
using FortyTwo.Entity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace FortyTwo.Entity.Migrations
{
    [DbContext(typeof(DatabaseContext))]
    partial class DatabaseContextModelSnapshot : ModelSnapshot
    {
        protected override void BuildModel(ModelBuilder modelBuilder)
        {
#pragma warning disable 612, 618
            modelBuilder
                .HasAnnotation("ProductVersion", "6.0.1")
                .HasAnnotation("Relational:MaxIdentifierLength", 63);

            NpgsqlModelBuilderExtensions.UseIdentityByDefaultColumns(modelBuilder);

            modelBuilder.Entity("FortyTwo.Entity.Models.Match", b =>
                {
                    b.Property<Guid>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("uuid")
                        .HasColumnName("id");

                    b.Property<DateTimeOffset>("CreatedOn")
                        .HasColumnType("timestamp with time zone")
                        .HasColumnName("created_on");

                    b.Property<string>("CurrentGame")
                        .HasColumnType("text")
                        .HasColumnName("current_game_json");

                    b.Property<string>("Games")
                        .HasColumnType("text")
                        .HasColumnName("games_json");

                    b.Property<DateTimeOffset>("UpdatedOn")
                        .HasColumnType("timestamp with time zone")
                        .HasColumnName("updated_on");

                    b.Property<int?>("WinningTeam")
                        .HasColumnType("integer")
                        .HasColumnName("winning_team");

                    b.HasKey("Id");

                    b.HasIndex("CreatedOn")
                        .HasAnnotation("SqlServer:Clustered", false);

                    b.HasIndex("UpdatedOn")
                        .HasAnnotation("SqlServer:Clustered", false);

                    b.ToTable("matches", (string)null);
                });

            modelBuilder.Entity("FortyTwo.Entity.Models.MatchPlayer", b =>
                {
                    b.Property<int>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("integer");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<int>("Id"));

                    b.Property<Guid>("MatchId")
                        .HasColumnType("uuid")
                        .HasColumnName("match_id");

                    b.Property<string>("PlayerId")
                        .IsRequired()
                        .HasColumnType("text")
                        .HasColumnName("player_id");

                    b.Property<int>("Position")
                        .HasColumnType("integer")
                        .HasColumnName("position");

                    b.HasKey("Id");

                    b.HasIndex("MatchId")
                        .HasAnnotation("SqlServer:Clustered", false);

                    b.HasIndex("PlayerId")
                        .HasAnnotation("SqlServer:Clustered", false);

                    b.ToTable("match_players", (string)null);
                });

            modelBuilder.Entity("FortyTwo.Entity.Models.MatchPlayer", b =>
                {
                    b.HasOne("FortyTwo.Entity.Models.Match", "Match")
                        .WithMany("Players")
                        .HasForeignKey("MatchId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("Match");
                });

            modelBuilder.Entity("FortyTwo.Entity.Models.Match", b =>
                {
                    b.Navigation("Players");
                });
#pragma warning restore 612, 618
        }
    }
}
