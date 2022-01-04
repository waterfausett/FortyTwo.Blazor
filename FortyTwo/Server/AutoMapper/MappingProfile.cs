using AutoMapper;
using FortyTwo.Shared.Models;
using System.Collections.Generic;
using System.Linq;

namespace FortyTwo.Server.AutoMapper
{
    public class MappingProfile : Profile
    {
        public MappingProfile()
        {
            CreateMap<Entity.Models.MatchPlayer, Player>()
                .ForMember(dest => dest.Id, opt => opt.MapFrom(src => src.PlayerId));

            // TODO: this mapping could prolly be better 🙃
            CreateMap<Entity.Models.Match, Shared.DTO.Match>()
                .ForMember(dest => dest.Players, opt => opt.Ignore())
                .ForMember(dest => dest.Teams, opt => opt.MapFrom(src => new Dictionary<Teams, List<Player>>()
                {
                    { Teams.TeamA, src.Players.Where(p => (int)p.Position % 2 == 0).Select(x => new Player() { Id = x.PlayerId, Position = x.Position }).ToList() },
                    { Teams.TeamB, src.Players.Where(p => (int)p.Position % 2 != 0).Select(x => new Player() { Id = x.PlayerId, Position = x.Position }).ToList() },
                }));

            CreateMap<Hand, Shared.DTO.Hand>()
                .ForMember(dest => dest.Dominos, opt => opt.MapFrom(src => src.Dominos.Count));

            CreateMap<Game, Shared.DTO.Game>();
        }
    }
}
