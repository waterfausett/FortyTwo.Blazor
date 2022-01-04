﻿using AutoMapper;
using FortyTwo.Shared.Models;
using System.Collections.Generic;
using System.Linq;

namespace FortyTwo.Server.AutoMapper
{
    public class MappingProfile : Profile
    {
        public MappingProfile()
        {
            //CreateMap<Player, Shared.Models.DTO.Player>()

            CreateMap<Entity.Models.Match, Shared.DTO.Match>()
                .ForMember(dest => dest.Players, opt => opt.Ignore())
                .ForMember(dest => dest.Teams, opt => opt.MapFrom(src => new Dictionary<Teams, List<Player>>()
                {
                    { Teams.TeamA, src.Players.Where(p => (int)p.Position % 2 == 0).Select(x => new Player() { Id = x.PlayerId, Position = x.Position }).ToList() },
                    { Teams.TeamB, src.Players.Where(p => (int)p.Position % 2 != 0).Select(x => new Player() { Id = x.PlayerId, Position = x.Position }).ToList() },
                }));
                    
            /*
                .ForMember(dest => dest.Players, opt => opt.MapFrom(src => src.Players.Select(p =>
                    new Shared.Models.DTO.Player
                    {
                        Id = p.Id,
                        Name = p.Name,
                        TeamId = p.TeamId,
                        IsActive = src.CurrentGame.CurrentPlayerId == p.Id,
                        Bid = src.CurrentGame.Hands.First(x => x.PlayerId == p.Id).Bid,
                        DominoCount = src.CurrentGame.Hands.First(x => x.PlayerId == p.Id).Dominos.Count,
                    })));
            */

            /*
            CreateMap<Match, Shared.Models.DTO.Game>()
                .ForMember(dest => dest.Id, opt => opt.MapFrom(src => src.CurrentGame.Id))
                .ForMember(dest => dest.Name, opt => opt.MapFrom(src => src.CurrentGame.Id))
                .ForMember(dest => dest.BiddingPlayerId, opt => opt.MapFrom(src => src.CurrentGame.BiddingPlayerId))
                .ForMember(dest => dest.Bid, opt => opt.MapFrom(src => src.CurrentGame.Bid))
                .ForMember(dest => dest.CurrentPlayerId, opt => opt.MapFrom(src => src.CurrentGame.CurrentPlayerId))
                .ForMember(dest => dest.CurrentTrick, opt => opt.MapFrom(src => src.CurrentGame.CurrentTrick))
                .ForMember(dest => dest.Tricks, opt => opt.MapFrom(src => src.CurrentGame.Tricks))
                .ForMember(dest => dest.Trump, opt => opt.MapFrom(src => src.CurrentGame.Trump))
                .ForMember(dest => dest.Players, opt => opt.MapFrom(src => src.Players.Select(p => 
                    new Shared.Models.DTO.Player
                    {
                        Id = p.Id,
                        Name = p.Name,
                        TeamId = p.TeamId,
                        IsActive = src.CurrentGame.CurrentPlayerId == p.Id,
                        Bid = src.CurrentGame.Hands.First(x => x.PlayerId == p.Id).Bid,
                        DominoCount = src.CurrentGame.Hands.First(x => x.PlayerId == p.Id).Dominos.Count,
                    })));
            */

            CreateMap<Hand, Shared.DTO.Hand>()
                .ForMember(dest => dest.Dominos, opt => opt.MapFrom(src => src.Dominos.Count));

            CreateMap<Game, Shared.DTO.Game>();
                /*
                .ForMember(dest => dest.Players, opt => opt.MapFrom(src => src.Hands.Select(h =>
                    new Shared.Models.DTO.Player
                    {
                        Id = h.PlayerId,
                        //Name = h.Name,
                        TeamId = h.TeamId,
                        IsActive = src.CurrentPlayerId == h.PlayerId,
                        Bid = src.Hands.First(x => x.PlayerId == h.PlayerId).Bid,
                        DominoCount = src.Hands.First(x => x.PlayerId == h.PlayerId).Dominos.Count,
                    })));
                */
        }
    }
}
